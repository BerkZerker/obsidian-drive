/**
 * In-memory doubles for end-to-end sync tests:
 * - FakeDrive mimics the subset of the Google Drive v3 API the plugin uses,
 *   including folder trees, revision history, and the Changes API cursor.
 * - FakeIO mimics VaultIO with an in-memory file map.
 * Both are duck-typed to the real classes' public surfaces.
 */

function md5ish(bytes) {
	// FNV-1a — not md5, but all the tests need is a stable content fingerprint.
	let hash = 0x811c9dc5;
	const view = new Uint8Array(bytes);
	for (const b of view) {
		hash ^= b;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return "md5-" + hash.toString(16) + "-" + view.length;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

export class FakeDrive {
	constructor() {
		this.nodes = new Map(); // id -> {name, parentId, mimeType, data?, revisions?: [{id, data}], trashed}
		this.changeLog = []; // DriveChange[]
		this.nextId = 1;
		this.listTreeCalls = 0;
	}

	newId() {
		return "f" + this.nextId++;
	}

	recordChange(id) {
		const n = this.nodes.get(id);
		this.changeLog.push(
			n
				? {
						fileId: id,
						removed: false,
						file: {
							id,
							name: n.name,
							mimeType: n.mimeType,
							md5Checksum: n.data ? md5ish(n.data) : undefined,
							parents: [n.parentId],
							trashed: n.trashed,
						},
				  }
				: { fileId: id, removed: true }
		);
	}

	// ---- DriveClient surface ----------------------------------------------

	async ensureBaseFolder(name, cachedId) {
		if (cachedId && this.nodes.get(cachedId) && !this.nodes.get(cachedId).trashed) return cachedId;
		for (const [id, n] of this.nodes) {
			if (n.mimeType === FOLDER_MIME && n.parentId === "root" && n.name === name && !n.trashed) return id;
		}
		const id = this.newId();
		this.nodes.set(id, { name, parentId: "root", mimeType: FOLDER_MIME, trashed: false });
		this.recordChange(id);
		return id;
	}

	async listTree(baseFolderId) {
		this.listTreeCalls++;
		const files = new Map();
		const folders = new Map([["", baseFolderId]]);
		const walk = (folderId, path) => {
			for (const [id, n] of this.nodes) {
				if (n.parentId !== folderId || n.trashed) continue;
				const childPath = path ? `${path}/${n.name}` : n.name;
				if (n.mimeType === FOLDER_MIME) {
					folders.set(childPath, id);
					walk(id, childPath);
				} else {
					files.set(childPath, {
						id,
						path: childPath,
						md5: md5ish(n.data),
						modifiedTime: n.modifiedTime ?? 0,
						size: n.data.byteLength,
					});
				}
			}
		};
		walk(baseFolderId, "");
		return { files, folders };
	}

	async ensureFolderPath(dirPath, folders) {
		if (!dirPath) return folders.get("");
		const known = folders.get(dirPath);
		if (known) return known;
		const parentPath = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : "";
		const parentId = await this.ensureFolderPath(parentPath, folders);
		const name = dirPath.slice(dirPath.lastIndexOf("/") + 1);
		const id = this.newId();
		this.nodes.set(id, { name, parentId, mimeType: FOLDER_MIME, trashed: false });
		this.recordChange(id);
		folders.set(dirPath, id);
		return id;
	}

	async uploadNew(name, parentId, data) {
		const id = this.newId();
		this.nodes.set(id, {
			name,
			parentId,
			mimeType: "application/octet-stream",
			data,
			revisions: [{ id: id + "-r1", data }],
			trashed: false,
		});
		this.recordChange(id);
		return { id, md5: md5ish(data) };
	}

	async uploadUpdate(fileId, data) {
		const n = this.nodes.get(fileId);
		if (!n || n.trashed) throw new Error(`Drive API 404 on PATCH file ${fileId}`);
		n.data = data;
		n.revisions.push({ id: fileId + "-r" + (n.revisions.length + 1), data });
		this.recordChange(fileId);
		return { md5: md5ish(data) };
	}

	async download(fileId) {
		const n = this.nodes.get(fileId);
		if (!n || n.trashed) throw new Error(`Drive API 404 on GET file ${fileId}`);
		return n.data;
	}

	async trash(fileId) {
		const n = this.nodes.get(fileId);
		if (!n) throw new Error(`Drive API 404 on trash ${fileId}`);
		n.trashed = true;
		this.recordChange(fileId);
	}

	async getParents(fileId) {
		return [this.nodes.get(fileId).parentId];
	}

	async move(fileId, newName, addParentId, removeParentIds) {
		const n = this.nodes.get(fileId);
		n.name = newName;
		if (removeParentIds.filter((p) => p !== addParentId).length || n.parentId !== addParentId) {
			n.parentId = addParentId;
		}
		this.recordChange(fileId);
	}

	async findByName(name, parentId) {
		for (const [id, n] of this.nodes) {
			if (n.parentId === parentId && n.name === name && !n.trashed) return { id };
		}
		return null;
	}

	async getStartPageToken() {
		return String(this.changeLog.length);
	}

	async listChanges(pageToken) {
		const from = parseInt(pageToken, 10);
		if (Number.isNaN(from) || from > this.changeLog.length) throw new Error("Drive API 410: invalid page token");
		return { changes: this.changeLog.slice(from), newStartPageToken: String(this.changeLog.length) };
	}

	async findRevisionByMd5(fileId, md5) {
		const n = this.nodes.get(fileId);
		for (const rev of n?.revisions ?? []) {
			if (md5ish(rev.data) === md5) return rev.id;
		}
		return null;
	}

	async downloadRevision(fileId, revisionId) {
		const rev = this.nodes.get(fileId)?.revisions.find((r) => r.id === revisionId);
		if (!rev) throw new Error(`Drive API 404 on revision ${revisionId}`);
		return rev.data;
	}

	async listRevisionMeta(fileId) {
		return (this.nodes.get(fileId)?.revisions ?? []).map((r, i) => ({
			id: r.id,
			modifiedTime: new Date(2026, 0, i + 1).toISOString(),
			size: r.data.byteLength,
		}));
	}

	// ---- test helpers ------------------------------------------------------

	/** path -> decoded text of live files under the base folder (marker excluded). */
	async snapshot(baseFolderId) {
		const { files } = await this.listTree(baseFolderId);
		const out = {};
		for (const [path, f] of files) {
			if (path === ".obsidian-drive-meta.json") continue;
			out[path] = new TextDecoder().decode(this.nodes.get(f.id).data);
		}
		return out;
	}

	rawBytes(baseFolderId, path) {
		const parts = path.split("/");
		let parentId = baseFolderId;
		for (const part of parts) {
			let found = null;
			for (const [id, n] of this.nodes) {
				if (n.parentId === parentId && n.name === part && !n.trashed) found = id;
			}
			if (!found) return null;
			parentId = found;
		}
		return this.nodes.get(parentId)?.data ?? null;
	}
}

let clock = 1000;

export class FakeIO {
	constructor() {
		this.files = new Map(); // path -> {data, mtime, size}
	}

	setText(path, text) {
		const data = new TextEncoder().encode(text).buffer;
		this.files.set(path, { data, mtime: ++clock, size: data.byteLength });
	}

	getText(path) {
		const f = this.files.get(path);
		return f ? new TextDecoder().decode(f.data) : null;
	}

	deleteFile(path) {
		this.files.delete(path);
	}

	renameFile(from, to) {
		const f = this.files.get(from);
		this.files.delete(from);
		this.files.set(to, f); // same content + mtime, like a real filesystem move
	}

	// ---- VaultIO surface ---------------------------------------------------

	async listAll() {
		return new Map([...this.files].map(([path, f]) => [path, { path, mtime: f.mtime, size: f.size }]));
	}

	async read(path) {
		const f = this.files.get(path);
		if (!f) throw new Error(`Local file not found: ${path}`);
		return f.data;
	}

	async write(path, data) {
		const meta = { data, mtime: ++clock, size: data.byteLength };
		this.files.set(path, meta);
		return { path, mtime: meta.mtime, size: meta.size };
	}

	async remove(path) {
		this.files.delete(path);
	}

	async rename(from, to) {
		const f = this.files.get(from);
		if (!f) throw new Error(`Local file not found: ${from}`);
		this.files.delete(from);
		this.files.set(to, f);
		return { path: to, mtime: f.mtime, size: f.size };
	}
}

/** One simulated device: its own vault, plugin data, and sync context. */
export function makeDevice(drive, overrides = {}) {
	const io = new FakeIO();
	const data = {
		settings: {},
		tokens: null,
		state: {},
		baseFolderId: null,
		vaultId: null,
		encryptionSalt: null,
		changesPageToken: null,
		folderIds: {},
	};
	const logs = [];
	const ctx = {
		io,
		client: drive,
		data,
		saveData: async () => {},
		log: (m) => logs.push(m),
		confirmDeletions: async () => true,
		...overrides.ctx,
	};
	const opts = {
		dryRun: false,
		conflictStrategy: "smart-merge",
		ignorePrefixes: [],
		includeConfig: false,
		configExcludes: [],
		driveFolderName: "Vault",
		encryptionPassword: "",
		deletionGuardThreshold: 0,
		...overrides.opts,
	};
	return { io, data, ctx, opts, logs };
}
