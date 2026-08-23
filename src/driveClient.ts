import { requestUrl, RequestUrlResponse } from "obsidian";
import { RemoteFile } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface DriveFileMeta {
	id: string;
	name: string;
	mimeType: string;
	md5Checksum?: string;
	modifiedTime?: string;
	size?: string;
}

export interface RemoteListing {
	/** Vault-relative path -> remote file. Google-native docs are excluded. */
	files: Map<string, RemoteFile>;
	/** Directory path ("" = base folder) -> Drive folder id. */
	folders: Map<string, string>;
}

export interface DriveChange {
	fileId: string;
	removed: boolean;
	file?: {
		id: string;
		name: string;
		mimeType: string;
		md5Checksum?: string;
		modifiedTime?: string;
		size?: string;
		parents?: string[];
		trashed?: boolean;
	};
}

export interface RevisionMeta {
	id: string;
	modifiedTime: string;
	size: number;
}

/**
 * Minimal Google Drive v3 client built on Obsidian's requestUrl (no CORS
 * issues, works on desktop and mobile). Token refresh is delegated to the
 * getAccessToken callback so auth state stays owned by the plugin.
 */
export class DriveClient {
	constructor(private getAccessToken: (forceRefresh: boolean) => Promise<string>) {}

	private async request(params: {
		url: string;
		method?: string;
		body?: string | ArrayBuffer;
		contentType?: string;
	}): Promise<RequestUrlResponse> {
		let token = await this.getAccessToken(false);
		for (let attempt = 0; ; attempt++) {
			const resp = await requestUrl({
				url: params.url,
				method: params.method ?? "GET",
				body: params.body,
				contentType: params.contentType,
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});
			if (resp.status === 401 && attempt === 0) {
				token = await this.getAccessToken(true);
				continue;
			}
			// Back off once on rate limiting / transient server errors.
			if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
				continue;
			}
			if (resp.status >= 400) {
				let detail = "";
				try {
					detail = resp.json?.error?.message ?? resp.text.slice(0, 300);
				} catch {
					/* body may not be text */
				}
				throw new Error(`Drive API ${resp.status} on ${params.method ?? "GET"} ${params.url.split("?")[0]}: ${detail}`);
			}
			return resp;
		}
	}

	async getAccountEmail(): Promise<string> {
		const resp = await this.request({ url: `${API}/about?fields=user(emailAddress)` });
		return resp.json?.user?.emailAddress ?? "unknown";
	}

	private async listChildren(folderId: string): Promise<DriveFileMeta[]> {
		const out: DriveFileMeta[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: `'${folderId}' in parents and trashed = false`,
				fields: "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, size)",
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const resp = await this.request({ url: `${API}/files?${params.toString()}` });
			out.push(...(resp.json.files ?? []));
			pageToken = resp.json.nextPageToken;
		} while (pageToken);
		return out;
	}

	/** Finds (or creates) the vault's base folder at the root of My Drive. */
	async ensureBaseFolder(name: string, cachedId: string | null): Promise<string> {
		if (cachedId) {
			// Verify the cached folder still exists and isn't trashed.
			const resp = await requestUrl({
				url: `${API}/files/${cachedId}?fields=id,trashed`,
				headers: { Authorization: `Bearer ${await this.getAccessToken(false)}` },
				throw: false,
			});
			if (resp.status === 200 && !resp.json.trashed) return cachedId;
		}
		const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		const q = new URLSearchParams({
			q: `name = '${escaped}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
			fields: "files(id)",
		});
		const found = await this.request({ url: `${API}/files?${q.toString()}` });
		if (found.json.files?.length) return found.json.files[0].id;
		const created = await this.request({
			url: `${API}/files?fields=id`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
		});
		return created.json.id;
	}

	/** Walks the base folder tree and returns every synced file and folder id. */
	async listTree(baseFolderId: string): Promise<RemoteListing> {
		const files = new Map<string, RemoteFile>();
		const folders = new Map<string, string>([["", baseFolderId]]);
		const queue: Array<{ id: string; path: string }> = [{ id: baseFolderId, path: "" }];

		while (queue.length) {
			const { id, path } = queue.shift() as { id: string; path: string };
			for (const child of await this.listChildren(id)) {
				const childPath = path ? `${path}/${child.name}` : child.name;
				if (child.mimeType === FOLDER_MIME) {
					folders.set(childPath, child.id);
					queue.push({ id: child.id, path: childPath });
				} else if (child.md5Checksum) {
					// Files without md5Checksum are Google-native docs; skip them.
					files.set(childPath, {
						id: child.id,
						path: childPath,
						md5: child.md5Checksum,
						modifiedTime: child.modifiedTime ? Date.parse(child.modifiedTime) : 0,
						size: child.size ? parseInt(child.size, 10) : 0,
					});
				}
			}
		}
		return { files, folders };
	}

	/** Creates any missing folders along dirPath and returns the deepest id. */
	async ensureFolderPath(dirPath: string, folders: Map<string, string>): Promise<string> {
		if (!dirPath) return folders.get("") as string;
		const known = folders.get(dirPath);
		if (known) return known;
		const parentPath = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : "";
		const parentId = await this.ensureFolderPath(parentPath, folders);
		const name = dirPath.slice(dirPath.lastIndexOf("/") + 1);
		const created = await this.request({
			url: `${API}/files?fields=id`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
		});
		folders.set(dirPath, created.json.id);
		return created.json.id;
	}

	async download(fileId: string): Promise<ArrayBuffer> {
		const resp = await this.request({ url: `${API}/files/${fileId}?alt=media` });
		return resp.arrayBuffer;
	}

	/** Current cursor for the Changes API; changes after this point are listable. */
	async getStartPageToken(): Promise<string> {
		const resp = await this.request({ url: `${API}/changes/startPageToken` });
		return resp.json.startPageToken;
	}

	/** All changes since the given cursor, plus the cursor for next time. */
	async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
		const changes: DriveChange[] = [];
		let token = pageToken;
		let newStartPageToken = pageToken;
		for (;;) {
			const params = new URLSearchParams({
				pageToken: token,
				pageSize: "1000",
				restrictToMyDrive: "true",
				fields:
					"nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, md5Checksum, modifiedTime, size, parents, trashed))",
			});
			const resp = await this.request({ url: `${API}/changes?${params.toString()}` });
			changes.push(...(resp.json.changes ?? []));
			if (resp.json.newStartPageToken) newStartPageToken = resp.json.newStartPageToken;
			if (!resp.json.nextPageToken) break;
			token = resp.json.nextPageToken;
		}
		return { changes, newStartPageToken };
	}

	async getParents(fileId: string): Promise<string[]> {
		const resp = await this.request({ url: `${API}/files/${fileId}?fields=parents` });
		return resp.json.parents ?? [];
	}

	/** Renames and/or moves a file — metadata only, preserves revision history. */
	async move(fileId: string, newName: string, addParentId: string, removeParentIds: string[]): Promise<void> {
		const params = new URLSearchParams({ fields: "id" });
		const removals = removeParentIds.filter((p) => p !== addParentId);
		if (removals.length) {
			params.set("addParents", addParentId);
			params.set("removeParents", removals.join(","));
		}
		await this.request({
			url: `${API}/files/${fileId}?${params.toString()}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ name: newName }),
		});
	}

	/** Finds a file by exact name directly inside the given folder. */
	async findByName(name: string, parentId: string): Promise<{ id: string } | null> {
		const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		const params = new URLSearchParams({
			q: `name = '${escaped}' and '${parentId}' in parents and trashed = false`,
			fields: "files(id)",
		});
		const resp = await this.request({ url: `${API}/files?${params.toString()}` });
		return resp.json.files?.length ? { id: resp.json.files[0].id } : null;
	}

	async listRevisionMeta(fileId: string): Promise<RevisionMeta[]> {
		const out: RevisionMeta[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				fields: "nextPageToken, revisions(id, modifiedTime, size)",
				pageSize: "200",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const resp = await this.request({ url: `${API}/files/${fileId}/revisions?${params.toString()}` });
			for (const rev of resp.json.revisions ?? []) {
				out.push({ id: rev.id, modifiedTime: rev.modifiedTime, size: parseInt(rev.size ?? "0", 10) });
			}
			pageToken = resp.json.nextPageToken;
		} while (pageToken);
		return out;
	}

	/**
	 * Finds the revision whose content matches the given md5 — used to recover
	 * the common ancestor for three-way merges. Drive keeps revisions of
	 * app-created files for ~30 days, so this can return null for old bases.
	 */
	async findRevisionByMd5(fileId: string, md5: string): Promise<string | null> {
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				fields: "nextPageToken, revisions(id, md5Checksum)",
				pageSize: "200",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const resp = await this.request({ url: `${API}/files/${fileId}/revisions?${params.toString()}` });
			for (const rev of resp.json.revisions ?? []) {
				if (rev.md5Checksum === md5) return rev.id;
			}
			pageToken = resp.json.nextPageToken;
		} while (pageToken);
		return null;
	}

	async downloadRevision(fileId: string, revisionId: string): Promise<ArrayBuffer> {
		const resp = await this.request({ url: `${API}/files/${fileId}/revisions/${revisionId}?alt=media` });
		return resp.arrayBuffer;
	}

	async uploadNew(name: string, parentId: string, data: ArrayBuffer): Promise<{ id: string; md5: string }> {
		const boundary = "obsidian_drive_sync_boundary";
		const metadata = JSON.stringify({ name, parents: [parentId] });
		const head = new TextEncoder().encode(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
				`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
		);
		const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
		const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
		body.set(head, 0);
		body.set(new Uint8Array(data), head.byteLength);
		body.set(tail, head.byteLength + data.byteLength);

		const resp = await this.request({
			url: `${UPLOAD_API}/files?uploadType=multipart&fields=id,md5Checksum`,
			method: "POST",
			contentType: `multipart/related; boundary=${boundary}`,
			body: body.buffer,
		});
		return { id: resp.json.id, md5: resp.json.md5Checksum };
	}

	async uploadUpdate(fileId: string, data: ArrayBuffer): Promise<{ md5: string }> {
		const resp = await this.request({
			url: `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=md5Checksum`,
			method: "PATCH",
			contentType: "application/octet-stream",
			body: data,
		});
		return { md5: resp.json.md5Checksum };
	}

	/** Moves a file to the Drive trash (recoverable for 30 days). */
	async trash(fileId: string): Promise<void> {
		await this.request({
			url: `${API}/files/${fileId}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ trashed: true }),
		});
	}
}
