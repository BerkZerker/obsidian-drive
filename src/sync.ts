import { normalizePath, TFile, Vault } from "obsidian";
import { DriveClient, RemoteListing } from "./driveClient";
import { ConflictStrategy, FileState, RemoteFile, SyncState } from "./types";

export interface SyncReport {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	skipped: number;
	errors: string[];
}

export interface SyncOptions {
	vault: Vault;
	client: DriveClient;
	baseFolderId: string;
	state: SyncState;
	conflictStrategy: ConflictStrategy;
	ignorePrefixes: string[];
	onProgress?: (message: string) => void;
	saveState: () => Promise<void>;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function isIgnored(path: string, prefixes: string[]): boolean {
	return prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"));
}

function conflictCopyPath(path: string): string {
	const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	if (dot > slash) return `${path.slice(0, dot)} (conflict ${stamp})${path.slice(dot)}`;
	return `${path} (conflict ${stamp})`;
}

interface LocalEntry {
	file: TFile;
	hash: string | null; // computed lazily
}

/**
 * Three-way sync: compares the current local vault and the current remote
 * listing against the snapshot recorded at the last successful sync, so it can
 * distinguish "created here" from "deleted there" without guessing from
 * timestamps. Timestamps are only used as a tiebreak for the "newest" strategy.
 */
export async function runSync(opts: SyncOptions): Promise<SyncReport> {
	const { vault, client, state } = opts;
	const report: SyncReport = {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		skipped: 0,
		errors: [],
	};

	opts.onProgress?.("Listing Google Drive…");
	const remote: RemoteListing = await client.listTree(opts.baseFolderId);

	const localFiles = new Map<string, LocalEntry>();
	for (const file of vault.getFiles()) {
		if (isIgnored(file.path, opts.ignorePrefixes)) continue;
		localFiles.set(file.path, { file, hash: null });
	}

	const allPaths = new Set<string>([
		...localFiles.keys(),
		...remote.files.keys(),
		...Object.keys(state),
	]);

	const readLocal = async (entry: LocalEntry): Promise<{ data: ArrayBuffer; hash: string }> => {
		const data = await vault.readBinary(entry.file);
		const hash = await sha256Hex(data);
		entry.hash = hash;
		return { data, hash };
	};

	/** True if the local file's content differs from the last-synced snapshot. */
	const localChanged = async (entry: LocalEntry, known: FileState): Promise<boolean> => {
		if (entry.file.stat.mtime === known.mtime && entry.file.stat.size === known.size) return false;
		const { hash } = await readLocal(entry);
		return hash !== known.localHash;
	};

	const upload = async (path: string, entry: LocalEntry, existing?: RemoteFile) => {
		const { data, hash } = await readLocal(entry);
		let remoteId: string;
		let md5: string;
		if (existing) {
			remoteId = existing.id;
			md5 = (await client.uploadUpdate(existing.id, data)).md5;
		} else {
			const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			const parentId = await client.ensureFolderPath(dir, remote.folders);
			const name = path.slice(path.lastIndexOf("/") + 1);
			const created = await client.uploadNew(name, parentId, data);
			remoteId = created.id;
			md5 = created.md5;
		}
		state[path] = {
			remoteId,
			localHash: hash,
			remoteMd5: md5,
			mtime: entry.file.stat.mtime,
			size: entry.file.stat.size,
		};
		report.uploaded++;
	};

	const writeLocalFile = async (path: string, data: ArrayBuffer): Promise<TFile> => {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (dir && !vault.getFolderByPath(normalizePath(dir))) {
			// createFolder creates intermediate folders one level at a time.
			const parts = dir.split("/");
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				if (!vault.getFolderByPath(normalizePath(current))) {
					await vault.createFolder(normalizePath(current));
				}
			}
		}
		const existing = vault.getFileByPath(normalizePath(path));
		if (existing) {
			await vault.modifyBinary(existing, data);
			return existing;
		}
		return vault.createBinary(normalizePath(path), data);
	};

	const download = async (path: string, rf: RemoteFile) => {
		const data = await client.download(rf.id);
		const file = await writeLocalFile(path, data);
		state[path] = {
			remoteId: rf.id,
			localHash: await sha256Hex(data),
			remoteMd5: rf.md5,
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		report.downloaded++;
	};

	const resolveConflict = async (path: string, entry: LocalEntry, rf: RemoteFile) => {
		report.conflicts++;
		switch (opts.conflictStrategy) {
			case "prefer-local":
				await upload(path, entry, rf);
				break;
			case "prefer-remote":
				await download(path, rf);
				break;
			case "newest":
				if (entry.file.stat.mtime >= rf.modifiedTime) await upload(path, entry, rf);
				else await download(path, rf);
				break;
			case "conflict-copy": {
				// Keep local as-is, save the remote version alongside it, then
				// upload local so both devices end up seeing both versions.
				const remoteData = await client.download(rf.id);
				const copyPath = conflictCopyPath(path);
				await writeLocalFile(copyPath, remoteData);
				opts.onProgress?.(`Conflict on ${path} — remote version saved as ${copyPath}`);
				await upload(path, entry, rf);
				break;
			}
		}
	};

	let processed = 0;
	for (const path of allPaths) {
		processed++;
		if (processed % 25 === 0) {
			opts.onProgress?.(`Syncing… ${processed}/${allPaths.size}`);
			await opts.saveState();
		}
		try {
			const entry = localFiles.get(path);
			const rf = remote.files.get(path);
			const known = state[path];

			if (entry && rf) {
				if (!known) {
					// New on both sides with no history: identical → adopt, else conflict.
					const { hash } = await readLocal(entry);
					state[path] = {
						remoteId: rf.id,
						localHash: hash,
						remoteMd5: rf.md5,
						mtime: entry.file.stat.mtime,
						size: entry.file.stat.size,
					};
					// Uploading local over remote would be destructive without
					// comparing; re-download only if content differs.
					const remoteData = await client.download(rf.id);
					const remoteHash = await sha256Hex(remoteData);
					if (remoteHash !== hash) {
						delete state[path];
						await resolveConflict(path, entry, rf);
					}
					continue;
				}
				const lChanged = await localChanged(entry, known);
				const rChanged = rf.md5 !== known.remoteMd5;
				if (lChanged && rChanged) await resolveConflict(path, entry, rf);
				else if (lChanged) await upload(path, entry, rf);
				else if (rChanged) await download(path, rf);
				else {
					// Keep id fresh in case the file was recreated remotely.
					known.remoteId = rf.id;
					report.skipped++;
				}
			} else if (entry && !rf) {
				if (!known) {
					await upload(path, entry); // created locally
				} else if (await localChanged(entry, known)) {
					await upload(path, entry); // deleted remotely but edited here → keep it
				} else {
					await vault.trash(entry.file, false); // deleted remotely, unchanged here
					delete state[path];
					report.deletedLocal++;
				}
			} else if (!entry && rf) {
				if (!known) {
					await download(path, rf); // created remotely
				} else if (rf.md5 !== known.remoteMd5) {
					await download(path, rf); // deleted locally but edited remotely → restore
				} else {
					await client.trash(rf.id); // deleted locally, unchanged remotely
					delete state[path];
					report.deletedRemote++;
				}
			} else {
				delete state[path]; // gone on both sides
			}
		} catch (e) {
			report.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	await opts.saveState();
	return report;
}
