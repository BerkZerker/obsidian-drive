# Google Drive Sync for Obsidian

Sync your Obsidian vault with a folder in your own Google Drive. Files are mirrored as a normal folder tree in Drive, so you can also browse and back up your notes outside Obsidian.

**Key properties**

- Uses the **`drive.file`** OAuth scope — the plugin can only see files *it* created. It cannot read the rest of your Drive, and Google treats this as a non-sensitive scope (no app-verification hoops for your personal OAuth client).
- **Auto-merges conflicts**: when a note changed on two devices, the plugin recovers the common ancestor from Drive's revision history and performs a git-style three-way merge, combining both sets of edits. Only when the *same lines* were edited on both sides does it fall back to keeping both versions (`Note (conflict 2026-08-23 1530).md`). Nothing is ever silently overwritten.
- **Syncs automatically**: a debounced sync runs ~30 s after you stop editing, plus sync on window focus, a periodic sync (default every 15 min), and optional sync-on-launch.
- **Fast**: steady-state syncs use the Drive Changes API to skip listing the whole remote tree, transfers run 4-way parallel, and renames/moves are detected and applied as metadata-only operations (no re-upload, revision history preserved).
- **Safe**: a mass-deletion guard asks before a single sync deletes many files, a vault marker prevents two different vaults from clobbering the same Drive folder, deletions go to trash on both sides, and a dry-run command previews exactly what a sync would do.
- **Optional end-to-end encryption** (AES-256-GCM) so Google cannot read your notes.
- Works with **all file types**, on desktop and mobile (see [Mobile](#mobile)), and can optionally sync your `.obsidian` config folder.

## Setup

Google requires each user to authorize apps through an OAuth client. Rather than shipping a shared secret in the plugin, you create your own free client — it takes about five minutes and only has access to its own files:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project (any name, e.g. `obsidian-sync`).
2. **APIs & Services → Library** → search for **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → choose **External**, fill in the app name and your email. You don't need to add scopes or test users for `drive.file`. Under **Audience**, click **Publish app** (this avoids refresh tokens expiring after 7 days; no verification is required for non-sensitive scopes).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type **Desktop app**.
5. Copy the **Client ID** and **Client secret** into the plugin settings in Obsidian.
6. Click **Connect to Google Drive** in the plugin settings and finish the sign-in in your browser. (Google will warn that the app is unverified — it's *your* app; click *Advanced → Go to …*.)
7. Run **Sync now** from the command palette, ribbon icon, or let auto-sync handle it.

Your vault appears in Drive under the folder named in settings (default: `Obsidian Vault`).

## Installing the plugin

Until this is in the community plugin directory, install manually:

1. Run `npm install && npm run build` in this repo.
2. Copy `manifest.json` and `main.js` into `<your vault>/.obsidian/plugins/google-drive-sync/`.
3. Enable **Google Drive Sync** in *Settings → Community plugins*.

## Mobile

Obsidian mobile can't run the localhost OAuth flow, so:

1. Connect on desktop first.
2. In desktop settings, click **Copy auth bundle**.
3. Get the bundle to your phone (any private channel), then in the plugin settings on mobile click **Paste auth bundle**.

The bundle contains your refresh token — treat it like a password and delete it from wherever you pasted it after importing.

## How syncing works

Syncs run automatically: shortly after you stop editing (debounced, configurable quiet period), when the window regains focus, on a periodic interval, optionally at launch, and on demand via the ribbon icon or the **Sync now** command.

Every sync:

1. Asks the Drive **Changes API** what changed remotely since last time. If nothing relevant changed, the full remote listing is skipped entirely — a purely local editing session syncs with a handful of API calls.
2. Compares local files and remote files against the last-synced snapshot (a true three-way comparison, so "created here" and "deleted there" are never confused).
3. Detects renames/moves — by content hash locally, by Drive file id remotely — and applies them as metadata operations instead of delete + re-transfer.
4. Runs uploads, downloads, and deletions 4 at a time, applying your conflict strategy where needed.

### Conflict handling

When a file changed on both sides since the last sync, the default **Auto-merge** strategy:

1. Looks up the last-synced version of the file in Drive's revision history (the common ancestor).
2. Runs a line-based three-way merge — edits to *different* parts of the file are combined, identical edits are deduplicated.
3. Falls back to a conflict copy only when both sides edited the same lines differently, when the file isn't text (e.g. images), or when the ancestor revision has aged out of Drive's revision history (~30 days).

You can instead choose plain conflict copies, newest-wins, or always-local/always-remote in settings.

### Safety features

- **Mass-deletion guard**: if a single sync would delete more than N files (default 10), a confirmation dialog lists them first. Declining aborts the sync with nothing changed — protection against an accidentally emptied vault propagating everywhere.
- **Vault marker**: a small `.obsidian-drive-meta.json` file in the Drive folder records which vault owns it. Pointing a *different* vault at the same folder refuses to sync instead of merging two vaults into each other. The **Adopt Drive folder** command intentionally links a new vault (e.g. a fresh install) to an existing folder.
- **Trash, not delete**: remote deletions go to the Drive trash (30-day recovery); local deletions go to the vault's `.trash`.
- **Preview sync (dry run)**: shows the full action list — uploads, downloads, deletions, renames, conflicts — without executing anything.
- **View sync log**: a timestamped log of everything recent syncs did.

### End-to-end encryption

Set an **encryption password** in settings to encrypt file *content* with AES-256-GCM before upload (key derived per-vault via PBKDF2, 310k iterations). Google then stores only ciphertext. Notes:

- Use the **same password on every device**. The (non-secret) key salt is shared automatically through the Drive folder's marker file.
- File **names** stay plaintext so the Drive folder stays navigable and renames stay cheap. If your note *titles* are sensitive, this isn't enough.
- After enabling, run **Force re-upload of all files** to encrypt files that are already on Drive. Files uploaded before encryption remain readable either way.
- If you lose the password, the encrypted copies on Drive are unrecoverable (your local vault is of course untouched).

### Version history

**View version history for current file** lists the revisions Google Drive keeps (~30 days) and restores any of them with one click. The restored version becomes your local file and uploads on the next sync.

### Config folder sync

Optionally sync `.obsidian` (themes, snippets, community plugins, settings) across devices. Per-device files like `workspace.json` are excluded by default and the exclusion list is editable. This plugin's own folder is **always** excluded — it contains your Google tokens and per-device sync state. After config changes arrive from another device, reload Obsidian to apply them.

### Other notes

- Google-native files (Docs/Sheets) in the sync folder are ignored — they have no binary content to download.
- **Reset sync state** forces the next sync to re-compare every file — useful after restoring backups.

## Is Google Drive actually a good choice for this?

Honest trade-offs versus the alternatives:

| Option | Cost | E2E encrypted | Mobile | Merge quality | Effort |
|---|---|---|---|---|---|
| **This plugin (Google Drive)** | free 15 GB | optional | auth via export | three-way line merge | 5-min OAuth setup |
| **Obsidian Sync (official)** | $4–8/mo | yes | excellent | per-edit merging, version history | zero |
| **Remotely Save plugin** | varies | optional | yes | file-level | low |
| **obsidian-git** | free | no | poor on mobile | line-level (git) | medium |
| **Syncthing** | free | in transit | Android only | file-level | medium |

- Choose **Google Drive (this plugin)** if you already live in Google's ecosystem and want free sync plus a browsable copy of your vault in Drive.
- Choose **Obsidian Sync** if you want the most reliable, zero-maintenance option — it merges concurrent edits in real time rather than at sync points.
- Choose **obsidian-git** if you want full history forever and mostly work on desktop.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # type-check + production bundle
npm test       # unit + end-to-end simulation tests
```

The test suite (52 tests, run in CI on every push) covers the merge engine, the sync planner, the encryption codec, and full end-to-end scenarios: two simulated devices syncing through an in-memory fake of the Drive API — including its change log and revision history — exercising propagation, auto-merge, conflict copies, renames, the deletion guard, the vault marker, encryption, and the fast path.

Source layout: `src/main.ts` (plugin lifecycle), `src/auth.ts` (OAuth PKCE loopback flow), `src/driveClient.ts` (Drive v3 REST), `src/planner.ts` (pure sync planner), `src/sync.ts` (orchestrator + parallel executor), `src/merge.ts` (diff3 merge), `src/crypto.ts` (E2E encryption), `src/vaultio.ts` (vault + config file access), `src/settings.ts` / `src/modals.ts` (UI).

## License

MIT
