import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { RevisionMeta } from "./driveClient";
import { PlanAction, SyncPlan } from "./planner";

/** Generic yes/no dialog resolving to true only on explicit confirmation. */
export class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private title: string,
		private body: string[],
		private ctaText: string,
		private resolve: (ok: boolean) => void
	) {
		super(app);
	}

	static ask(app: App, title: string, body: string[], ctaText: string): Promise<boolean> {
		return new Promise((resolve) => new ConfirmModal(app, title, body, ctaText, resolve).open());
	}

	onOpen() {
		this.titleEl.setText(this.title);
		for (const line of this.body) this.contentEl.createEl("p", { text: line });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			)
			.addButton((b) =>
				b
					.setButtonText(this.ctaText)
					.setWarning()
					.onClick(() => {
						this.resolved = true;
						this.resolve(true);
						this.close();
					})
			);
	}

	onClose() {
		if (!this.resolved) this.resolve(false);
		this.contentEl.empty();
	}
}

const ACTION_LABELS: Record<PlanAction["type"], string> = {
	"upload-new": "Upload (new)",
	"upload-update": "Upload (changed)",
	download: "Download",
	"delete-local": "Delete locally",
	"delete-remote": "Delete on Drive",
	conflict: "Conflict to resolve",
	inspect: "Compare (new on both sides)",
	"rename-remote": "Rename on Drive",
	"rename-local": "Rename locally",
	"refresh-id": "Refresh metadata",
	forget: "Forget stale entry",
};

/** Shows what a sync would do, without doing it. */
export class DryRunModal extends Modal {
	constructor(app: App, private plan: SyncPlan) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Sync preview");
		const { actions, unchanged } = this.plan;
		if (actions.length === 0) {
			this.contentEl.createEl("p", { text: `Nothing to do — ${unchanged} file(s) already in sync.` });
			return;
		}
		this.contentEl.createEl("p", {
			text: `${actions.length} action(s) pending, ${unchanged} file(s) unchanged. Nothing has been executed.`,
		});
		const groups = new Map<string, string[]>();
		for (const a of actions) {
			const label = ACTION_LABELS[a.type];
			const desc = a.type === "rename-remote" || a.type === "rename-local" ? `${a.from} → ${a.to}` : a.path;
			(groups.get(label) ?? groups.set(label, []).get(label))?.push(desc);
		}
		for (const [label, paths] of groups) {
			this.contentEl.createEl("h5", { text: `${label} (${paths.length})` });
			const list = this.contentEl.createEl("ul");
			for (const p of paths.slice(0, 50)) list.createEl("li", { text: p });
			if (paths.length > 50) list.createEl("li", { text: `…and ${paths.length - 50} more` });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Browse and restore Drive revisions of a file. */
export class HistoryModal extends Modal {
	constructor(
		app: App,
		private filePath: string,
		private revisions: RevisionMeta[],
		private restore: (revisionId: string) => Promise<void>
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(`Version history — ${this.filePath}`);
		if (this.revisions.length === 0) {
			this.contentEl.createEl("p", { text: "No revisions found on Drive for this file." });
			return;
		}
		this.contentEl.createEl("p", {
			text: "Versions stored on Google Drive (kept ~30 days). Restoring overwrites the local file; the restored version uploads on the next sync.",
		});
		// Newest first.
		for (const rev of [...this.revisions].reverse()) {
			const row = new Setting(this.contentEl)
				.setName(new Date(rev.modifiedTime).toLocaleString())
				.setDesc(`${(rev.size / 1024).toFixed(1)} KB`);
			row.addButton((b: ButtonComponent) =>
				b.setButtonText("Restore").onClick(async () => {
					b.setDisabled(true);
					try {
						await this.restore(rev.id);
						new Notice(`Restored ${this.filePath} to the version from ${new Date(rev.modifiedTime).toLocaleString()}`);
						this.close();
					} catch (e) {
						new Notice(`Restore failed: ${e instanceof Error ? e.message : e}`);
						b.setDisabled(false);
					}
				})
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class LogModal extends Modal {
	constructor(app: App, private text: string) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Sync log");
		const pre = this.contentEl.createEl("pre", { text: this.text });
		pre.style.maxHeight = "60vh";
		pre.style.overflow = "auto";
		pre.style.whiteSpace = "pre-wrap";
		pre.style.userSelect = "text";
	}

	onClose() {
		this.contentEl.empty();
	}
}
