import { DriveChange, DriveClient } from "./driveClient";
import { ContentCodec, createEncryptionCodec, generateSaltB64, plaintextCodec } from "./crypto";
import { isMergeableTextPath, mergeThreeWay } from "./merge";
import { basename, dirname, PlanAction, PlanRemote, planSync, SyncPlan } from "./planner";
import { ConflictStrategy, FileState, PluginData } from "./types";
import { LocalMeta, VaultIO } from "./vaultio";

export const MARKER_NAME = ".obsidian-drive-meta.json";
const TRANSFER_CONCURRENCY = 4;

export interface SyncReport {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	renamed: number;
	conflicts: number;
	merged: number;
	skipped: number;
	errors: string[];
	aborted: boolean;
	/** True when the Changes API let this sync skip the full remote listing. */
	fastPath: boolean;
}

export interface SyncContext {
	io: VaultIO;
	client: DriveClient;
	data: PluginData;
	saveData(): Promise<void>;
	log(message: string): void;
	onProgress?(message: string): void;
	/** Called when a sync wants to delete >= threshold files; false aborts. */
	confirmDeletions(paths: string[]): Promise<boolean>;
}

export class VaultMismatchError extends Error {
	constructor() {
		super(
			"The Drive folder belongs to a different vault. Change the Drive folder name in settings, " +
				"or run “Adopt Drive folder” to link this vault to it."
		);
	}
}

interface VaultMarker {
	vaultId: string;
	salt?: string;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function randomId(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function conflictCopyPath(path: string): string {
	const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	if (dot > slash) return `${path.slice(0, dot)} (conflict ${stamp})${path.slice(dot)}`;
	return `${path} (conflict ${stamp})`;
}

function isIgnored(path: string, prefixes: string[]): boolean {
	return prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"));
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			await fn(items[index]);
		}
	});
	await Promise.all(workers);
}

/** Reads (or creates) the marker file that ties a Drive folder to one vault. */
async function checkMarker(ctx: SyncContext, baseFolderId: string, wantSalt: boolean): Promise<VaultMarker> {
	const { client, data } = ctx;
	const existing = await client.findByName(MARKER_NAME, baseFolderId);
	if (existing) {
		const marker = JSON.parse(new TextDecoder().decode(await client.download(existing.id))) as VaultMarker;
		if (!data.vaultId) data.vaultId = marker.vaultId;
		else if (data.vaultId !== marker.vaultId) throw new VaultMismatchError();
		if (wantSalt && !marker.salt) {
			marker.salt = generateSaltB64();
			const body = new TextEncoder().encode(JSON.stringify(marker)).buffer as ArrayBuffer;
			await client.uploadUpdate(existing.id, body);
		}
		return marker;
	}
	const marker: VaultMarker = { vaultId: data.vaultId ?? randomId() };
	if (wantSalt) marker.salt = generateSaltB64();
	data.vaultId = marker.vaultId;
	const body = new TextEncoder().encode(JSON.stringify(marker)).buffer as ArrayBuffer;
	await client.uploadNew(MARKER_NAME, baseFolderId, body);
	return marker;
}

/** Links this vault to whatever vault id the Drive folder's marker carries. */
export async function adoptDriveFolder(ctx: SyncContext, folderName: string): Promise<void> {
	const baseFolderId = await ctx.client.ensureBaseFolder(folderName, ctx.data.baseFolderId);
	ctx.data.baseFolderId = baseFolderId;
	const existing = await ctx.client.findByName(MARKER_NAME, baseFolderId);
	if (existing) {
		const marker = JSON.parse(new TextDecoder().decode(await ctx.client.download(existing.id))) as VaultMarker;
		ctx.data.vaultId = marker.vaultId;
	} else {
		ctx.data.vaultId = null; // next sync creates a fresh marker
	}
	ctx.data.state = {};
	ctx.data.changesPageToken = null;
	await ctx.saveData();
}

/**
 * Decides whether any remote change since the last sync touches our tree.
 * Our own uploads come back as changes too; those are filtered out by
 * comparing against the recorded md5/name/parent, so a purely local editing
 * session never pays for a full remote listing.
 */
function anyRelevantChanges(changes: DriveChange[], data: PluginData, baseFolderId: string): boolean {
	const idToPath = new Map<string, string>();
	for (const [path, s] of Object.entries(data.state)) idToPath.set(s.remoteId, path);
	const folderIdToPath = new Map<string, string>();
	folderIdToPath.set(baseFolderId, "");
	for (const [path, id] of Object.entries(data.folderIds)) folderIdToPath.set(id, path);

	for (const ch of changes) {
		const knownFile = idToPath.get(ch.fileId);
		const knownFolder = folderIdToPath.get(ch.fileId);
		if (ch.removed || ch.file?.trashed) {
			if (knownFile !== undefined || (knownFolder !== undefined && knownFolder !== "")) return true;
			continue;
		}
		const f = ch.file;
		if (!f || f.name === MARKER_NAME) continue;
		if (knownFile !== undefined) {
			const s = data.state[knownFile];
			if (f.md5Checksum !== undefined && f.md5Checksum !== s.remoteMd5) return true;
			if (f.name !== basename(knownFile)) return true;
			const parentPath = dirname(knownFile);
			const expectedParent = parentPath === "" ? baseFolderId : data.folderIds[parentPath];
			if (expectedParent && f.parents && !f.parents.includes(expectedParent)) return true;
			continue;
		}
		if (knownFolder !== undefined) {
			if (knownFolder === "") continue; // the base folder itself
			if (f.name !== basename(knownFolder)) return true;
			const parentPath = dirname(knownFolder);
			const expectedParent = parentPath === "" ? baseFolderId : data.folderIds[parentPath];
			if (expectedParent && f.parents && !f.parents.includes(expectedParent)) return true;
			continue;
		}
		// Unknown id: relevant only if it appeared inside our tree.
		if (f.parents?.some((p) => folderIdToPath.has(p))) return true;
	}
	return false;
}

export interface SyncRunOptions {
	dryRun?: boolean;
	conflictStrategy: ConflictStrategy;
	ignorePrefixes: string[];
	includeConfig: boolean;
	configExcludes: string[];
	driveFolderName: string;
	encryptionPassword: string;
	deletionGuardThreshold: number;
}

export interface DryRunResult {
	plan: SyncPlan;
	fastPath: boolean;
}

export async function performSync(ctx: SyncContext, opts: SyncRunOptions): Promise<SyncReport | DryRunResult> {
	const { client, data, io } = ctx;

	ctx.onProgress?.("Checking Drive folder…");
	const baseFolderId = await client.ensureBaseFolder(opts.driveFolderName, data.baseFolderId);
	if (baseFolderId !== data.baseFolderId) {
		data.baseFolderId = baseFolderId;
		data.changesPageToken = null; // folder changed → cursor is meaningless
		await ctx.saveData();
	}

	const wantEncryption = opts.encryptionPassword.length > 0;
	const marker = await checkMarker(ctx, baseFolderId, wantEncryption);
	data.encryptionSalt = marker.salt ?? null;
	await ctx.saveData();
	const codec: ContentCodec =
		wantEncryption && marker.salt
			? await createEncryptionCodec(opts.encryptionPassword, marker.salt)
			: plaintextCodec;

	// ---- Decide fast path (Changes API) vs full listing --------------------
	let fastPath = false;
	let nextChangesToken: string | null = null;
	if (!opts.dryRun && data.changesPageToken) {
		try {
			const { changes, newStartPageToken } = await client.listChanges(data.changesPageToken);
			if (!anyRelevantChanges(changes, data, baseFolderId)) {
				fastPath = true;
				nextChangesToken = newStartPageToken;
				ctx.log(`Fast path: ${changes.length} remote change(s), none relevant`);
			}
		} catch (e) {
			ctx.log(`Changes cursor invalid, falling back to full listing: ${e instanceof Error ? e.message : e}`);
			data.changesPageToken = null;
		}
	}

	// ---- Gather local + remote metadata ------------------------------------
	ctx.onProgress?.("Scanning vault…");
	const localAll = await io.listAll(opts.includeConfig, opts.configExcludes);
	const local = new Map<string, LocalMeta>();
	for (const [path, meta] of localAll) {
		if (!isIgnored(path, opts.ignorePrefixes)) local.set(path, meta);
	}

	let remote: Map<string, PlanRemote>;
	let folders: Map<string, string>;
	if (fastPath) {
		remote = new Map();
		for (const [path, s] of Object.entries(data.state)) {
			remote.set(path, { id: s.remoteId, md5: s.remoteMd5, modifiedTime: 0 });
		}
		folders = new Map(Object.entries(data.folderIds));
		folders.set("", baseFolderId);
	} else {
		if (!opts.dryRun) nextChangesToken = await client.getStartPageToken();
		ctx.onProgress?.("Listing Google Drive…");
		const listing = await client.listTree(baseFolderId);
		listing.files.delete(MARKER_NAME);
		remote = new Map();
		for (const [path, rf] of listing.files) {
			if (!isIgnored(path, opts.ignorePrefixes)) {
				remote.set(path, { id: rf.id, md5: rf.md5, modifiedTime: rf.modifiedTime });
			}
		}
		folders = listing.folders;
	}

	// ---- Plan --------------------------------------------------------------
	const hashCache = new Map<string, string>();
	const localHash = async (path: string): Promise<string> => {
		const cached = hashCache.get(path);
		if (cached) return cached;
		const hash = await sha256Hex(await io.read(path));
		hashCache.set(path, hash);
		return hash;
	};
	const isLocalChanged = async (path: string): Promise<boolean> => {
		const s = data.state[path];
		const m = local.get(path);
		if (!s || !m) return true;
		if (m.mtime === s.mtime && m.size === s.size) return false;
		return (await localHash(path)) !== s.localHash;
	};

	ctx.onProgress?.("Planning…");
	const plan = await planSync({ local, remote, state: data.state, isLocalChanged, localHash });

	if (opts.dryRun) return { plan, fastPath };

	const report: SyncReport = {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		renamed: 0,
		conflicts: 0,
		merged: 0,
		skipped: plan.unchanged,
		errors: [],
		aborted: false,
		fastPath,
	};

	// ---- Mass-deletion guard ----------------------------------------------
	if (opts.deletionGuardThreshold > 0 && plan.deletionPaths.length >= opts.deletionGuardThreshold) {
		ctx.log(`Deletion guard: sync wants to delete ${plan.deletionPaths.length} files, asking for confirmation`);
		if (!(await ctx.confirmDeletions(plan.deletionPaths))) {
			report.aborted = true;
			ctx.log("Sync aborted by deletion guard");
			return report;
		}
	}

	// ---- Execute -----------------------------------------------------------
	// Create all needed folders up front so parallel workers never race on it.
	const newDirs = new Set<string>();
	for (const a of plan.actions) {
		if (a.type === "upload-new") newDirs.add(dirname(a.path));
		if (a.type === "rename-remote") newDirs.add(dirname(a.to));
	}
	for (const dir of newDirs) await client.ensureFolderPath(dir, folders);

	let saveChain = Promise.resolve();
	const queueSave = () => {
		saveChain = saveChain.then(() => ctx.saveData()).catch(() => undefined);
	};

	let done = 0;
	const executor = new ActionExecutor(ctx, codec, folders, local, opts.conflictStrategy, report, localHash);
	await runPool(plan.actions, TRANSFER_CONCURRENCY, async (action) => {
		try {
			await executor.execute(action);
		} catch (e) {
			const path = "path" in action ? action.path : action.to;
			report.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			ctx.log(`ERROR ${path}: ${e instanceof Error ? e.message : e}`);
		}
		done++;
		if (done % 20 === 0) {
			ctx.onProgress?.(`Syncing… ${done}/${plan.actions.length}`);
			queueSave();
		}
	});

	// ---- Persist cursors ---------------------------------------------------
	if (nextChangesToken) data.changesPageToken = nextChangesToken;
	data.folderIds = Object.fromEntries([...folders].filter(([path]) => path !== ""));
	await saveChain;
	await ctx.saveData();
	return report;
}

class ActionExecutor {
	constructor(
		private ctx: SyncContext,
		private codec: ContentCodec,
		private folders: Map<string, string>,
		private local: Map<string, LocalMeta>,
		private strategy: ConflictStrategy,
		private report: SyncReport,
		private localHash: (path: string) => Promise<string>
	) {}

	async execute(action: PlanAction): Promise<void> {
		const { ctx, report } = this;
		const state = ctx.data.state;
		switch (action.type) {
			case "upload-new":
			case "upload-update": {
				await this.upload(action.path, action.type === "upload-update" ? action.remoteId : undefined);
				break;
			}
			case "download": {
				await this.download(action.path, action.remote);
				break;
			}
			case "delete-local": {
				await ctx.io.remove(action.path);
				delete state[action.path];
				report.deletedLocal++;
				ctx.log(`Deleted locally: ${action.path}`);
				break;
			}
			case "delete-remote": {
				await ctx.client.trash(action.remoteId);
				delete state[action.path];
				report.deletedRemote++;
				ctx.log(`Trashed on Drive: ${action.path}`);
				break;
			}
			case "rename-remote": {
				const parents = await ctx.client.getParents(action.remoteId);
				const newParent = this.folders.get(dirname(action.to));
				if (!newParent) throw new Error(`Missing Drive folder for ${action.to}`);
				await ctx.client.move(action.remoteId, basename(action.to), newParent, parents);
				const s = state[action.from];
				const meta = this.local.get(action.to);
				state[action.to] = {
					remoteId: action.remoteId,
					localHash: s.localHash,
					remoteMd5: s.remoteMd5,
					mtime: meta?.mtime ?? 0,
					size: meta?.size ?? s.size,
				};
				delete state[action.from];
				report.renamed++;
				ctx.log(`Renamed on Drive: ${action.from} → ${action.to}`);
				break;
			}
			case "rename-local": {
				const s = state[action.from];
				const meta = await ctx.io.rename(action.from, action.to);
				state[action.to] = {
					remoteId: action.remote.id,
					localHash: s.localHash,
					remoteMd5: action.remote.md5,
					mtime: meta.mtime,
					size: meta.size,
				};
				delete state[action.from];
				report.renamed++;
				ctx.log(`Renamed locally: ${action.from} → ${action.to}`);
				break;
			}
			case "refresh-id": {
				state[action.path].remoteId = action.remoteId;
				report.skipped++;
				break;
			}
			case "forget": {
				delete state[action.path];
				break;
			}
			case "inspect": {
				const localData = await ctx.io.read(action.path);
				const localHashValue = await sha256Hex(localData);
				const remoteData = await this.codec.decode(await ctx.client.download(action.remote.id));
				if ((await sha256Hex(remoteData)) === localHashValue) {
					const meta = this.local.get(action.path);
					state[action.path] = {
						remoteId: action.remote.id,
						localHash: localHashValue,
						remoteMd5: action.remote.md5,
						mtime: meta?.mtime ?? 0,
						size: meta?.size ?? localData.byteLength,
					};
					this.report.skipped++;
				} else {
					await this.resolveConflict(action.path, action.remote, undefined);
				}
				break;
			}
			case "conflict": {
				await this.resolveConflict(action.path, action.remote, state[action.path]);
				break;
			}
		}
	}

	private async upload(path: string, existingId: string | undefined): Promise<void> {
		const { ctx } = this;
		const raw = await ctx.io.read(path);
		const hash = await sha256Hex(raw);
		const encoded = await this.codec.encode(raw);
		let remoteId: string;
		let md5: string;
		if (existingId) {
			remoteId = existingId;
			md5 = (await ctx.client.uploadUpdate(existingId, encoded)).md5;
		} else {
			const parentId = this.folders.get(dirname(path));
			if (!parentId) throw new Error(`Missing Drive folder for ${path}`);
			const created = await ctx.client.uploadNew(basename(path), parentId, encoded);
			remoteId = created.id;
			md5 = created.md5;
		}
		const meta = this.local.get(path);
		ctx.data.state[path] = {
			remoteId,
			localHash: hash,
			remoteMd5: md5,
			mtime: meta?.mtime ?? 0,
			size: meta?.size ?? raw.byteLength,
		};
		this.report.uploaded++;
		ctx.log(`Uploaded: ${path}`);
	}

	private async download(path: string, remote: PlanRemote): Promise<void> {
		const { ctx } = this;
		const data = await this.codec.decode(await ctx.client.download(remote.id));
		const meta = await ctx.io.write(path, data);
		ctx.data.state[path] = {
			remoteId: remote.id,
			localHash: await sha256Hex(data),
			remoteMd5: remote.md5,
			mtime: meta.mtime,
			size: meta.size,
		};
		this.report.downloaded++;
		ctx.log(`Downloaded: ${path}`);
	}

	private async resolveConflict(path: string, remote: PlanRemote, known: FileState | undefined): Promise<void> {
		const { ctx } = this;
		this.report.conflicts++;
		switch (this.strategy) {
			case "smart-merge": {
				if (known && (await this.trySmartMerge(path, remote, known))) return;
				await this.saveConflictCopy(path, remote);
				return;
			}
			case "conflict-copy":
				await this.saveConflictCopy(path, remote);
				return;
			case "prefer-local":
				await this.upload(path, remote.id);
				return;
			case "prefer-remote":
				await this.download(path, remote);
				return;
			case "newest": {
				const meta = this.local.get(path);
				if ((meta?.mtime ?? 0) >= remote.modifiedTime) await this.upload(path, remote.id);
				else await this.download(path, remote);
				return;
			}
		}
	}

	private async saveConflictCopy(path: string, remote: PlanRemote): Promise<void> {
		const { ctx } = this;
		const remoteData = await this.codec.decode(await ctx.client.download(remote.id));
		const copyPath = conflictCopyPath(path);
		await ctx.io.write(copyPath, remoteData);
		ctx.log(`Conflict on ${path} — remote version saved as ${copyPath}`);
		await this.upload(path, remote.id);
	}

	private async trySmartMerge(path: string, remote: PlanRemote, known: FileState): Promise<boolean> {
		const { ctx } = this;
		if (!isMergeableTextPath(path)) return false;
		const revisionId = await ctx.client.findRevisionByMd5(remote.id, known.remoteMd5);
		if (!revisionId) return false;

		const decoder = new TextDecoder();
		const baseText = decoder.decode(await this.codec.decode(await ctx.client.downloadRevision(remote.id, revisionId)));
		const localText = decoder.decode(await ctx.io.read(path));
		const remoteText = decoder.decode(await this.codec.decode(await ctx.client.download(remote.id)));

		const mergedText = mergeThreeWay(baseText, localText, remoteText);
		if (mergedText === null) return false;

		const mergedData = new TextEncoder().encode(mergedText).buffer as ArrayBuffer;
		const meta = await ctx.io.write(path, mergedData);
		const uploaded = await ctx.client.uploadUpdate(remote.id, await this.codec.encode(mergedData));
		ctx.data.state[path] = {
			remoteId: remote.id,
			localHash: await sha256Hex(mergedData),
			remoteMd5: uploaded.md5,
			mtime: meta.mtime,
			size: meta.size,
		};
		this.report.merged++;
		ctx.log(`Auto-merged both edits of ${path}`);
		return true;
	}
}
