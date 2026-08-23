/** OAuth tokens returned by Google. */
export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms after which accessToken is stale. */
	expiresAt: number;
}

export type ConflictStrategy = "conflict-copy" | "newest" | "prefer-local" | "prefer-remote";

export interface DriveSyncSettings {
	clientId: string;
	clientSecret: string;
	/** Name of the folder created at the root of Drive that holds the vault. */
	driveFolderName: string;
	/** 0 disables automatic sync. */
	autoSyncMinutes: number;
	syncOnStart: boolean;
	conflictStrategy: ConflictStrategy;
	/** One path prefix per line; matching vault paths are never synced. */
	ignorePatterns: string;
	verboseNotices: boolean;
}

export const DEFAULT_SETTINGS: DriveSyncSettings = {
	clientId: "",
	clientSecret: "",
	driveFolderName: "Obsidian Vault",
	autoSyncMinutes: 15,
	syncOnStart: false,
	conflictStrategy: "conflict-copy",
	ignorePatterns: "",
	verboseNotices: true,
};

/** What we knew about a file the last time it was successfully synced. */
export interface FileState {
	remoteId: string;
	/** SHA-256 (hex) of local content at last sync. */
	localHash: string;
	/** Drive md5Checksum at last sync. */
	remoteMd5: string;
	/** Local mtime (ms) at last sync — used to skip re-hashing unchanged files. */
	mtime: number;
	size: number;
}

export type SyncState = Record<string, FileState>;

export interface PluginData {
	settings: DriveSyncSettings;
	tokens: AuthTokens | null;
	state: SyncState;
	/** Drive folder id of the vault root folder, cached across runs. */
	baseFolderId: string | null;
}

export interface RemoteFile {
	id: string;
	/** Vault-relative path (forward slashes). */
	path: string;
	md5: string;
	modifiedTime: number;
	size: number;
}
