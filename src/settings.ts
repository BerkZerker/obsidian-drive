import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { authenticate } from "./auth";
import type DriveSyncPlugin from "./main";
import { ConflictStrategy } from "./types";

export class DriveSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DriveSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Google account")
			.setHeading();

		const connected = !!this.plugin.data.tokens;
		new Setting(containerEl)
			.setName(connected ? "Connected" : "Not connected")
			.setDesc(
				connected
					? "Sync is authorized. Disconnect to sign out or switch accounts."
					: "Create an OAuth client (Desktop app) in Google Cloud Console, paste its ID and secret below, then connect. See the README for a step-by-step guide."
			)
			.addButton((btn) =>
				btn
					.setButtonText(connected ? "Disconnect" : "Connect to Google Drive")
					.setCta()
					.onClick(async () => {
						if (connected) {
							this.plugin.data.tokens = null;
							await this.plugin.savePluginData();
							new Notice("Disconnected from Google Drive.");
							this.display();
							return;
						}
						try {
							this.plugin.data.tokens = await authenticate({
								clientId: this.plugin.data.settings.clientId.trim(),
								clientSecret: this.plugin.data.settings.clientSecret.trim(),
							});
							await this.plugin.savePluginData();
							const email = await this.plugin.getClient().getAccountEmail();
							new Notice(`Connected to Google Drive as ${email}`);
							this.display();
						} catch (e) {
							new Notice(`Google sign-in failed: ${e instanceof Error ? e.message : e}`, 10000);
						}
					})
			);

		new Setting(containerEl)
			.setName("OAuth client ID")
			.setDesc("From Google Cloud Console → APIs & Services → Credentials.")
			.addText((t) =>
				t
					.setPlaceholder("xxxx.apps.googleusercontent.com")
					.setValue(this.plugin.data.settings.clientId)
					.onChange(async (v) => {
						this.plugin.data.settings.clientId = v;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("OAuth client secret")
			.setDesc("The client secret of your Desktop-app OAuth client. Stored locally in this vault's plugin data.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.data.settings.clientSecret).onChange(async (v) => {
					this.plugin.data.settings.clientSecret = v;
					await this.plugin.savePluginData();
				});
			});

		new Setting(containerEl)
			.setName("Move auth to another device")
			.setDesc(
				"Mobile can't run the Google sign-in flow. Connect on desktop, copy the auth bundle there, and paste it on your phone or tablet."
			)
			.addButton((btn) =>
				btn.setButtonText("Copy auth bundle").onClick(async () => {
					if (!this.plugin.data.tokens) {
						new Notice("Connect on this device first.");
						return;
					}
					const bundle = btoa(
						JSON.stringify({
							tokens: this.plugin.data.tokens,
							clientId: this.plugin.data.settings.clientId,
							clientSecret: this.plugin.data.settings.clientSecret,
						})
					);
					await navigator.clipboard.writeText(bundle);
					new Notice("Auth bundle copied. Paste it on your other device. Treat it like a password.");
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Paste auth bundle").onClick(async () => {
					try {
						const raw = await navigator.clipboard.readText();
						const parsed = JSON.parse(atob(raw.trim()));
						if (!parsed?.tokens?.refreshToken) throw new Error("Not a valid auth bundle");
						this.plugin.data.tokens = parsed.tokens;
						this.plugin.data.settings.clientId = parsed.clientId ?? this.plugin.data.settings.clientId;
						this.plugin.data.settings.clientSecret =
							parsed.clientSecret ?? this.plugin.data.settings.clientSecret;
						await this.plugin.savePluginData();
						new Notice("Auth imported. This device can now sync.");
						this.display();
					} catch (e) {
						new Notice(`Import failed: ${e instanceof Error ? e.message : e}`);
					}
				})
			);

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Drive folder name")
			.setDesc("Folder created at the root of My Drive that holds this vault. Change before the first sync.")
			.addText((t) =>
				t.setValue(this.plugin.data.settings.driveFolderName).onChange(async (v) => {
					this.plugin.data.settings.driveFolderName = v || "Obsidian Vault";
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("0 disables automatic sync; you can always run “Sync now” from the command palette or ribbon.")
			.addText((t) =>
				t.setValue(String(this.plugin.data.settings.autoSyncMinutes)).onChange(async (v) => {
					const n = Math.max(0, parseInt(v, 10) || 0);
					this.plugin.data.settings.autoSyncMinutes = n;
					await this.plugin.savePluginData();
					this.plugin.restartAutoSync();
				})
			);

		new Setting(containerEl)
			.setName("Sync when Obsidian starts")
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.syncOnStart).onChange(async (v) => {
					this.plugin.data.settings.syncOnStart = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Sync shortly after edits")
			.setDesc("Automatically sync once you've stopped editing for the quiet period below.")
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.syncOnChange).onChange(async (v) => {
					this.plugin.data.settings.syncOnChange = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Quiet period after edits (seconds)")
			.setDesc("How long to wait after your last change before syncing. Minimum 5.")
			.addText((t) =>
				t.setValue(String(this.plugin.data.settings.syncOnChangeDelaySeconds)).onChange(async (v) => {
					const n = Math.max(5, parseInt(v, 10) || 30);
					this.plugin.data.settings.syncOnChangeDelaySeconds = n;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("When a file changed in both places")
			.setDesc(
				"“Auto-merge” combines both sets of edits line-by-line (like git) for text files, falling back to a conflict copy only when the same lines were edited on both sides."
			)
			.addDropdown((d) =>
				d
					.addOptions({
						"smart-merge": "Auto-merge, conflict copy if edits overlap (recommended)",
						"conflict-copy": "Keep both (conflict copy)",
						newest: "Keep the newest",
						"prefer-local": "Always keep this device's version",
						"prefer-remote": "Always keep the Drive version",
					})
					.setValue(this.plugin.data.settings.conflictStrategy)
					.onChange(async (v) => {
						this.plugin.data.settings.conflictStrategy = v as ConflictStrategy;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Deletion safety threshold")
			.setDesc(
				"Ask for confirmation before a single sync deletes this many files or more. Protects against an accidentally emptied vault wiping your Drive copy. 0 disables."
			)
			.addText((t) =>
				t.setValue(String(this.plugin.data.settings.deletionGuardThreshold)).onChange(async (v) => {
					this.plugin.data.settings.deletionGuardThreshold = Math.max(0, parseInt(v, 10) || 0);
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Sync when window regains focus")
			.setDesc("Pick up changes from other devices when you come back to Obsidian (at most once a minute).")
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.syncOnFocus).onChange(async (v) => {
					this.plugin.data.settings.syncOnFocus = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Sync the .obsidian config folder")
			.setDesc(
				"Sync themes, snippets, plugins, and settings across devices. Per-device files (workspace layout) are excluded below. This plugin's own data.json is never synced — it holds your Google tokens."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.syncConfigFolder).onChange(async (v) => {
					this.plugin.data.settings.syncConfigFolder = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Config paths to exclude")
			.setDesc("One path per line, relative to .obsidian. Only used when config sync is on.")
			.addTextArea((t) =>
				t.setValue(this.plugin.data.settings.configExcludes).onChange(async (v) => {
					this.plugin.data.settings.configExcludes = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Ignored paths")
			.setDesc("One folder or file path per line (vault-relative). These are never uploaded or downloaded.")
			.addTextArea((t) =>
				t
					.setPlaceholder("Private/\nScratch.md")
					.setValue(this.plugin.data.settings.ignorePatterns)
					.onChange(async (v) => {
						this.plugin.data.settings.ignorePatterns = v;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl).setName("Encryption").setHeading();

		new Setting(containerEl)
			.setName("Encryption password")
			.setDesc(
				"Non-empty enables end-to-end encryption: file content is AES-256-GCM encrypted before upload, so Google cannot read your notes (your Drive copy is no longer human-readable). Use the SAME password on every device. After enabling, run “Force re-upload of all files” to encrypt files already on Drive. If you lose the password, encrypted files on Drive are unrecoverable."
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.data.settings.encryptionPassword).onChange(async (v) => {
					this.plugin.data.settings.encryptionPassword = v;
					await this.plugin.savePluginData();
				});
			});

		new Setting(containerEl)
			.setName("Show sync notices")
			.setDesc("Pop up a summary after each sync. Errors are always shown.")
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.verboseNotices).onChange(async (v) => {
					this.plugin.data.settings.verboseNotices = v;
					await this.plugin.savePluginData();
				})
			);
	}
}
