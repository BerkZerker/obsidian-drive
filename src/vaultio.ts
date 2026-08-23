import { App, normalizePath } from "obsidian";

export interface LocalMeta {
	path: string;
	mtime: number;
	size: number;
}

/**
 * Unified local file access covering both regular vault files (TFile-based,
 * deletions go to trash) and files under the .obsidian config folder, which
 * Obsidian's Vault API doesn't index and must be reached via the adapter.
 */
export class VaultIO {
	/** The plugin's own config subfolder — never synced (contains OAuth tokens). */
	static readonly SELF_EXCLUDE = "plugins/google-drive-sync";

	constructor(private app: App) {}

	get configDir(): string {
		return this.app.vault.configDir;
	}

	private isConfigPath(path: string): boolean {
		return path === this.configDir || path.startsWith(this.configDir + "/");
	}

	async listAll(includeConfig: boolean, configExcludes: string[]): Promise<Map<string, LocalMeta>> {
		const out = new Map<string, LocalMeta>();
		for (const file of this.app.vault.getFiles()) {
			out.set(file.path, { path: file.path, mtime: file.stat.mtime, size: file.stat.size });
		}
		if (includeConfig) {
			const excludes = [...configExcludes, VaultIO.SELF_EXCLUDE]
				.map((e) => e.trim().replace(/^\/+|\/+$/g, ""))
				.filter((e) => e.length > 0)
				.map((e) => `${this.configDir}/${e}`);
			const isExcluded = (p: string) => excludes.some((e) => p === e || p.startsWith(e + "/"));

			const adapter = this.app.vault.adapter;
			const queue = [this.configDir];
			while (queue.length) {
				const dir = queue.shift() as string;
				let listing;
				try {
					listing = await adapter.list(dir);
				} catch {
					continue; // directory disappeared mid-scan
				}
				for (const sub of listing.folders) {
					if (!isExcluded(sub)) queue.push(sub);
				}
				for (const filePath of listing.files) {
					if (isExcluded(filePath)) continue;
					const stat = await adapter.stat(filePath);
					if (stat?.type === "file") {
						out.set(filePath, { path: filePath, mtime: stat.mtime, size: stat.size });
					}
				}
			}
		}
		return out;
	}

	async read(path: string): Promise<ArrayBuffer> {
		if (this.isConfigPath(path)) {
			return this.app.vault.adapter.readBinary(normalizePath(path));
		}
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`Local file not found: ${path}`);
		return this.app.vault.readBinary(file);
	}

	private async mkdirp(dir: string): Promise<void> {
		if (!dir) return;
		const parts = dir.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const p = normalizePath(current);
			if (this.isConfigPath(p)) {
				if (!(await this.app.vault.adapter.exists(p))) await this.app.vault.adapter.mkdir(p);
			} else if (!this.app.vault.getFolderByPath(p)) {
				await this.app.vault.createFolder(p);
			}
		}
	}

	async write(path: string, data: ArrayBuffer): Promise<LocalMeta> {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		await this.mkdirp(dir);
		const p = normalizePath(path);
		if (this.isConfigPath(p)) {
			await this.app.vault.adapter.writeBinary(p, data);
			const stat = await this.app.vault.adapter.stat(p);
			return { path, mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? data.byteLength };
		}
		const existing = this.app.vault.getFileByPath(p);
		const file = existing
			? (await this.app.vault.modifyBinary(existing, data), existing)
			: await this.app.vault.createBinary(p, data);
		return { path, mtime: file.stat.mtime, size: file.stat.size };
	}

	async remove(path: string): Promise<void> {
		const p = normalizePath(path);
		if (this.isConfigPath(p)) {
			await this.app.vault.adapter.remove(p);
			return;
		}
		const file = this.app.vault.getFileByPath(p);
		if (file) await this.app.vault.trash(file, false);
	}

	async rename(from: string, to: string): Promise<LocalMeta> {
		const toDir = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
		await this.mkdirp(toDir);
		const fromP = normalizePath(from);
		const toP = normalizePath(to);
		if (this.isConfigPath(fromP)) {
			await this.app.vault.adapter.rename(fromP, toP);
			const stat = await this.app.vault.adapter.stat(toP);
			return { path: to, mtime: stat?.mtime ?? Date.now(), size: stat?.size ?? 0 };
		}
		const file = this.app.vault.getFileByPath(fromP);
		if (!file) throw new Error(`Local file not found: ${from}`);
		await this.app.vault.rename(file, toP);
		return { path: to, mtime: file.stat.mtime, size: file.stat.size };
	}
}
