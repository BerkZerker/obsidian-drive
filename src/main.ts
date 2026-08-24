import { Notice, Plugin } from "obsidian";
import { ensureFreshTokens } from "./auth";
import { createEncryptionCodec, plaintextCodec } from "./crypto";
import { DriveClient } from "./driveClient";
import { SyncLog } from "./logger";
import { ConfirmModal, DryRunModal, HistoryModal, LogModal } from "./modals";
import { DriveSyncSettingTab } from "./settings";
import { adoptDriveFolder, DryRunResult, performSync, SyncContext, SyncReport, SyncRunOptions } from "./sync";
import { DEFAULT_SETTINGS, PluginData } from "./types";
import { VaultIO } from "./vaultio";

export default class DriveSyncPlugin extends Plugin {
	data: PluginData = this.emptyData();
	log = new SyncLog();
	private client: DriveClient | null = null;
	private io: VaultIO | null = null;
	private syncing = false;
	private lastSyncEnd = 0;
	private autoSyncTimer: number | null = null;
	private changeTimer: number | null = null;
	/** Set on every vault event; cleared when a sync starts. Edits made while a
	 *  sync is running set it again so a follow-up sync picks them up. */
	private pendingChanges = false;
	/** When the oldest not-yet-synced edit happened; bounds the debounce. */
	private firstPendingChangeAt: number | null = null;
	private autoSyncFailures = 0;
	private statusBar: HTMLElement | null = null;

	private emptyData(): PluginData {
		return {
			settings: { ...DEFAULT_SETTINGS },
			tokens: null,
			state: {},
			baseFolderId: null,
			vaultId: null,
			encryptionSalt: null,
			changesPageToken: null,
			folderIds: {},
		};
	}

	async onload() {
		await this.loadPluginData();
		this.io = new VaultIO(this.app);

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus("Drive: idle");

		this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.syncNow());

		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
		this.addCommand({
			id: "preview-sync",
			name: "Preview sync (dry run)",
			callback: () => void this.previewSync(),
		});
		this.addCommand({
			id: "version-history",
			name: "View version history for current file",
			callback: () => void this.showVersionHistory(),
		});
		this.addCommand({
			id: "view-sync-log",
			name: "View sync log",
			callback: () => new LogModal(this.app, this.log.text).open(),
		});
		this.addCommand({
			id: "adopt-drive-folder",
			name: "Adopt Drive folder (link this vault to the existing Drive folder)",
			callback: () => void this.adoptFolder(),
		});
		this.addCommand({
			id: "force-upload-all",
			name: "Force re-upload of all files (use after enabling encryption)",
			callback: () => void this.forceUploadAll(),
		});
		this.addCommand({
			id: "reset-sync-state",
			name: "Reset sync state (next sync re-compares every file)",
			callback: async () => {
				this.data.state = {};
				this.data.baseFolderId = null;
				this.data.changesPageToken = null;
				this.data.folderIds = {};
				await this.savePluginData();
				new Notice("Sync state cleared. The next sync will re-compare all files against Drive.");
			},
		});

		this.restartAutoSync();
		this.app.workspace.onLayoutReady(() => {
			if (this.data.settings.syncOnStart) void this.syncNow(true);
			// Registered after layout-ready so the initial vault index (which
			// fires a create event per file) doesn't trigger a sync.
			const onChange = () => this.scheduleChangeSync();
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("modify", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));
			const syncOnResume = () => {
				if (!this.data.settings.syncOnFocus) return;
				if (Date.now() - this.lastSyncEnd > 60_000) void this.syncNow(true);
			};
			this.registerDomEvent(window, "focus", syncOnResume);
			this.registerDomEvent(window, "blur", () => this.flushPendingChanges());
			// Mobile fires visibilitychange, not window focus/blur, when the app
			// is backgrounded or resumed — and the OS may suspend timers (or kill
			// the app) while hidden, so unsynced edits are pushed out immediately.
			this.registerDomEvent(document, "visibilitychange", () => {
				if (document.hidden) this.flushPendingChanges();
				else syncOnResume();
			});
		});
	}

	onunload() {
		if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
	}

	getClient(): DriveClient {
		if (!this.client) {
			this.client = new DriveClient(async (forceRefresh) => {
				if (!this.data.tokens) throw new Error("Not connected to Google Drive");
				if (forceRefresh) this.data.tokens.expiresAt = 0;
				const fresh = await ensureFreshTokens(
					{
						clientId: this.data.settings.clientId.trim(),
						clientSecret: this.data.settings.clientSecret.trim(),
					},
					this.data.tokens
				);
				if (fresh !== this.data.tokens) {
					this.data.tokens = fresh;
					await this.savePluginData();
				}
				return fresh.accessToken;
			});
		}
		return this.client;
	}

	restartAutoSync() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		const minutes = this.data.settings.autoSyncMinutes;
		if (minutes > 0) {
			this.autoSyncTimer = window.setInterval(() => void this.syncNow(true), minutes * 60_000);
			this.registerInterval(this.autoSyncTimer);
		}
	}

	private quietPeriodMs(): number {
		return Math.max(5, this.data.settings.syncOnChangeDelaySeconds) * 1000;
	}

	/** Debounced sync after edits: waits for a quiet period, then syncs. */
	private scheduleChangeSync() {
		if (!this.data.settings.syncOnChange || !this.data.tokens) return;
		this.pendingChanges = true;
		if (this.syncing) return; // picked up by the follow-up scheduled when this sync ends
		const now = Date.now();
		if (this.firstPendingChangeAt === null) this.firstPendingChangeAt = now;
		const quiet = this.quietPeriodMs();
		// Continuous editing keeps resetting the quiet-period timer, so cap the
		// total wait — the oldest unsynced edit never waits more than ~4 quiet
		// periods before a sync runs anyway.
		const maxWait = Math.max(4 * quiet, 60_000);
		const delay = Math.min(quiet, Math.max(this.firstPendingChangeAt + maxWait - now, 1000));
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		this.changeTimer = window.setTimeout(() => {
			this.changeTimer = null;
			void this.syncNow(true);
		}, delay);
	}

	/** Sync unsynced edits right now, skipping the quiet period. Called when the
	 *  app loses focus or is backgrounded: timers may never fire after that. */
	private flushPendingChanges() {
		if (!this.pendingChanges || this.syncing) return;
		if (!this.data.settings.syncOnChange || !this.data.tokens) return;
		if (this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
		void this.syncNow(true);
	}

	/** After a sync: re-run for edits made while it was in flight, or retry a
	 *  failure with backoff (offline, token hiccup) so edits aren't stranded
	 *  until the next periodic sync. */
	private scheduleFollowUpSync(afterFailure: boolean) {
		if (!this.data.settings.syncOnChange || !this.data.tokens) return;
		if (this.changeTimer !== null) return;
		const quiet = this.quietPeriodMs();
		const delay = afterFailure ? Math.min(quiet * 2 ** Math.min(this.autoSyncFailures, 6), 10 * 60_000) : quiet;
		this.changeTimer = window.setTimeout(() => {
			this.changeTimer = null;
			void this.syncNow(true);
		}, delay);
	}

	private buildContext(): SyncContext {
		return {
			io: this.io as VaultIO,
			client: this.getClient(),
			data: this.data,
			saveData: () => this.savePluginData(),
			log: (m) => this.log.add(m),
			onProgress: (m) => this.setStatus(`Drive: ${m}`),
			confirmDeletions: (paths) =>
				ConfirmModal.ask(
					this.app,
					"Confirm bulk deletion",
					[
						`This sync wants to delete ${paths.length} files (locally and/or on Drive).`,
						`Examples: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}`,
						"If you recently emptied or moved things intentionally, proceed. If this is unexpected, cancel and check your vault.",
					],
					`Delete ${paths.length} files`
				),
		};
	}

	private buildRunOptions(dryRun = false): SyncRunOptions {
		const s = this.data.settings;
		return {
			dryRun,
			conflictStrategy: s.conflictStrategy,
			ignorePrefixes: s.ignorePatterns
				.split("\n")
				.map((l) => l.trim().replace(/^\/+|\/+$/g, ""))
				.filter((l) => l.length > 0),
			includeConfig: s.syncConfigFolder,
			configExcludes: s.configExcludes.split("\n"),
			driveFolderName: s.driveFolderName.trim() || "Obsidian Vault",
			encryptionPassword: s.encryptionPassword,
			deletionGuardThreshold: s.deletionGuardThreshold,
		};
	}

	async syncNow(background = false) {
		if (this.syncing) {
			if (!background) new Notice("Sync already in progress.");
			return;
		}
		if (!this.data.tokens) {
			if (!background) new Notice("Connect to Google Drive in the plugin settings first.");
			return;
		}
		this.syncing = true;
		if (this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
		this.pendingChanges = false;
		this.firstPendingChangeAt = null;
		this.setStatus("Drive: syncing…");
		this.log.add(background ? "Sync started (automatic)" : "Sync started (manual)");
		let failed = false;
		try {
			const report = (await performSync(this.buildContext(), this.buildRunOptions())) as SyncReport;
			this.reportResult(report, background);
			this.autoSyncFailures = 0;
		} catch (e) {
			failed = true;
			this.autoSyncFailures++;
			const msg = e instanceof Error ? e.message : String(e);
			// Retries are silent after the first failure so being offline for a
			// while doesn't turn into a stream of notices.
			if (!background || this.autoSyncFailures <= 1) new Notice(`Drive sync failed: ${msg}`, 10000);
			this.log.add(`Sync failed: ${msg}`);
			console.error("[google-drive-sync]", e);
		} finally {
			this.syncing = false;
			this.lastSyncEnd = Date.now();
			this.setStatus(failed ? "Drive: sync failed" : `Drive: last sync ${new Date().toLocaleTimeString()}`);
			if (failed) this.pendingChanges = true;
			if (this.pendingChanges) this.scheduleFollowUpSync(failed);
		}
	}

	async previewSync() {
		if (this.syncing) {
			new Notice("Sync in progress — try again when it finishes.");
			return;
		}
		if (!this.data.tokens) {
			new Notice("Connect to Google Drive in the plugin settings first.");
			return;
		}
		this.syncing = true;
		this.setStatus("Drive: previewing…");
		try {
			const result = (await performSync(this.buildContext(), this.buildRunOptions(true))) as DryRunResult;
			new DryRunModal(this.app, result.plan).open();
		} catch (e) {
			new Notice(`Preview failed: ${e instanceof Error ? e.message : e}`, 10000);
		} finally {
			this.syncing = false;
			this.setStatus("Drive: idle");
		}
	}

	async showVersionHistory() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("Open a file first.");
			return;
		}
		const known = this.data.state[file.path];
		if (!known || !this.data.tokens) {
			new Notice("This file hasn't been synced to Drive yet.");
			return;
		}
		try {
			const revisions = await this.getClient().listRevisionMeta(known.remoteId);
			new HistoryModal(this.app, file.path, revisions, async (revisionId) => {
				const ctx = this.buildContext();
				const raw = await ctx.client.downloadRevision(known.remoteId, revisionId);
				const password = this.data.settings.encryptionPassword;
				const salt = this.data.encryptionSalt;
				// Older revisions may predate encryption; decode handles both.
				const codec = password && salt ? await createEncryptionCodec(password, salt) : plaintextCodec;
				await ctx.io.write(file.path, await codec.decode(raw));
			}).open();
		} catch (e) {
			new Notice(`Couldn't load version history: ${e instanceof Error ? e.message : e}`, 8000);
		}
	}

	async adoptFolder() {
		const ok = await ConfirmModal.ask(
			this.app,
			"Adopt Drive folder",
			[
				`This links the current vault to the Drive folder “${this.data.settings.driveFolderName}”, even if it was created by a different vault.`,
				"Sync state is reset; the next sync merges the Drive folder's contents with this vault.",
			],
			"Adopt folder"
		);
		if (!ok) return;
		try {
			await adoptDriveFolder(this.buildContext(), this.data.settings.driveFolderName.trim() || "Obsidian Vault");
			new Notice("Drive folder adopted. Run “Sync now” to merge.");
		} catch (e) {
			new Notice(`Adopt failed: ${e instanceof Error ? e.message : e}`, 8000);
		}
	}

	async forceUploadAll() {
		const ok = await ConfirmModal.ask(
			this.app,
			"Force re-upload",
			[
				"Every synced file will be re-uploaded to Drive on the next sync, overwriting the remote copies.",
				"Use this after enabling encryption so existing remote files get encrypted too.",
			],
			"Re-upload everything"
		);
		if (!ok) return;
		for (const s of Object.values(this.data.state)) {
			s.localHash = "force-reupload";
			s.mtime = -1;
		}
		await this.savePluginData();
		void this.syncNow();
	}

	private reportResult(report: SyncReport, background: boolean) {
		if (report.aborted) {
			new Notice("Drive sync cancelled — no files were deleted.", 8000);
			return;
		}
		const changes =
			report.uploaded + report.downloaded + report.deletedLocal + report.deletedRemote + report.renamed + report.conflicts;
		if (report.errors.length) {
			new Notice(`Drive sync finished with ${report.errors.length} error(s). First: ${report.errors[0]}`, 10000);
			console.error("[google-drive-sync] errors:", report.errors);
		}
		this.log.add(
			`Sync finished${report.fastPath ? " (fast path)" : ""}: ${report.uploaded} up, ${report.downloaded} down, ` +
				`${report.renamed} renamed, ${report.deletedLocal + report.deletedRemote} deleted, ${report.merged} merged, ${report.errors.length} errors`
		);
		if (!this.data.settings.verboseNotices) return;
		if (background && changes === 0) return; // stay quiet on no-op background syncs
		const parts: string[] = [];
		if (report.uploaded) parts.push(`${report.uploaded} uploaded`);
		if (report.downloaded) parts.push(`${report.downloaded} downloaded`);
		if (report.renamed) parts.push(`${report.renamed} renamed`);
		if (report.deletedLocal) parts.push(`${report.deletedLocal} removed locally`);
		if (report.deletedRemote) parts.push(`${report.deletedRemote} removed on Drive`);
		if (report.merged) parts.push(`${report.merged} auto-merged`);
		const unresolved = report.conflicts - report.merged;
		if (unresolved > 0) parts.push(`${unresolved} conflict(s)`);
		new Notice(parts.length ? `Drive sync: ${parts.join(", ")}` : "Drive sync: everything up to date");
	}

	private setStatus(text: string) {
		this.statusBar?.setText(text);
	}

	async loadPluginData() {
		const stored = (await this.loadData()) as Partial<PluginData> | null;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) },
			tokens: stored?.tokens ?? null,
			state: stored?.state ?? {},
			baseFolderId: stored?.baseFolderId ?? null,
			vaultId: stored?.vaultId ?? null,
			encryptionSalt: stored?.encryptionSalt ?? null,
			changesPageToken: stored?.changesPageToken ?? null,
			folderIds: stored?.folderIds ?? {},
		};
	}

	async savePluginData() {
		await this.saveData(this.data);
	}
}
