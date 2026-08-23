import { Notice, Plugin } from "obsidian";
import { ensureFreshTokens } from "./auth";
import { DriveClient } from "./driveClient";
import { DriveSyncSettingTab } from "./settings";
import { runSync, SyncReport } from "./sync";
import { DEFAULT_SETTINGS, PluginData } from "./types";

export default class DriveSyncPlugin extends Plugin {
	data: PluginData = { settings: { ...DEFAULT_SETTINGS }, tokens: null, state: {}, baseFolderId: null };
	private client: DriveClient | null = null;
	private syncing = false;
	private autoSyncTimer: number | null = null;
	private statusBar: HTMLElement | null = null;

	async onload() {
		await this.loadPluginData();

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus("Drive: idle");

		this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.syncNow());

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.syncNow(),
		});
		this.addCommand({
			id: "reset-sync-state",
			name: "Reset sync state (next sync re-compares every file)",
			callback: async () => {
				this.data.state = {};
				this.data.baseFolderId = null;
				await this.savePluginData();
				new Notice("Sync state cleared. The next sync will re-compare all files against Drive.");
			},
		});

		this.restartAutoSync();
		if (this.data.settings.syncOnStart) {
			// Wait for the workspace (and file index) to be ready.
			this.app.workspace.onLayoutReady(() => void this.syncNow());
		}
	}

	onunload() {
		if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
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
		this.setStatus("Drive: syncing…");
		try {
			const client = this.getClient();
			const baseFolderId = await client.ensureBaseFolder(
				this.data.settings.driveFolderName.trim() || "Obsidian Vault",
				this.data.baseFolderId
			);
			if (baseFolderId !== this.data.baseFolderId) {
				this.data.baseFolderId = baseFolderId;
				await this.savePluginData();
			}

			const ignorePrefixes = this.data.settings.ignorePatterns
				.split("\n")
				.map((l) => l.trim().replace(/^\/+|\/+$/g, ""))
				.filter((l) => l.length > 0);

			const report = await runSync({
				vault: this.app.vault,
				client,
				baseFolderId,
				state: this.data.state,
				conflictStrategy: this.data.settings.conflictStrategy,
				ignorePrefixes,
				onProgress: (m) => this.setStatus(`Drive: ${m}`),
				saveState: () => this.savePluginData(),
			});
			await this.savePluginData();
			this.reportResult(report, background);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Drive sync failed: ${msg}`, 10000);
			console.error("[google-drive-sync]", e);
		} finally {
			this.syncing = false;
			this.setStatus(`Drive: last sync ${new Date().toLocaleTimeString()}`);
		}
	}

	private reportResult(report: SyncReport, background: boolean) {
		const changes =
			report.uploaded + report.downloaded + report.deletedLocal + report.deletedRemote + report.conflicts;
		if (report.errors.length) {
			new Notice(
				`Drive sync finished with ${report.errors.length} error(s). First: ${report.errors[0]}`,
				10000
			);
			console.error("[google-drive-sync] errors:", report.errors);
		}
		if (!this.data.settings.verboseNotices) return;
		if (background && changes === 0) return; // stay quiet on no-op background syncs
		const parts: string[] = [];
		if (report.uploaded) parts.push(`${report.uploaded} uploaded`);
		if (report.downloaded) parts.push(`${report.downloaded} downloaded`);
		if (report.deletedLocal) parts.push(`${report.deletedLocal} removed locally`);
		if (report.deletedRemote) parts.push(`${report.deletedRemote} removed on Drive`);
		if (report.conflicts) parts.push(`${report.conflicts} conflict(s)`);
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
		};
	}

	async savePluginData() {
		await this.saveData(this.data);
	}
}
