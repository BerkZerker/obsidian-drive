# Google Drive Sync for Obsidian

Sync your Obsidian vault with a folder in your own Google Drive. Files are mirrored as a normal folder tree in Drive, so you can also browse and back up your notes outside Obsidian.

**Key properties**

- Uses the **`drive.file`** OAuth scope — the plugin can only see files *it* created. It cannot read the rest of your Drive, and Google treats this as a non-sensitive scope (no app-verification hoops for your personal OAuth client).
- **Three-way sync**: local vault and Drive are both compared against a snapshot from the last successful sync, so the plugin can tell "created here" apart from "deleted there" instead of guessing from timestamps.
- **Safe by default**: deletions go to the Drive trash / vault `.trash` (recoverable), and the default conflict strategy keeps *both* versions (`Note (conflict 2026-08-23 1530).md`) rather than silently overwriting.
- Works with **all file types** (markdown, images, PDFs, audio), on desktop and mobile (see [Mobile](#mobile)).

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

Every sync:

1. Lists the Drive folder tree and your vault files.
2. Compares both against the last-synced snapshot (stored in the plugin's `data.json`).
3. Uploads local changes, downloads remote changes, propagates deletions, and applies your chosen conflict strategy when a file changed in both places.

Notes:

- Google-native files (Docs/Sheets) in the sync folder are ignored — they have no binary content to download.
- The `.obsidian` config folder is not synced (by design — device-specific settings and workspace state cause more conflicts than they solve).
- "Reset sync state" in the command palette forces the next sync to re-compare every file — useful after restoring backups.

## Is Google Drive actually a good choice for this?

Honest trade-offs versus the alternatives:

| Option | Cost | E2E encrypted | Mobile | Merge quality | Effort |
|---|---|---|---|---|---|
| **This plugin (Google Drive)** | free 15 GB | no | auth via export | file-level, conflict copies | 5-min OAuth setup |
| **Obsidian Sync (official)** | $4–8/mo | yes | excellent | per-edit merging, version history | zero |
| **Remotely Save plugin** | varies | optional | yes | file-level | low |
| **obsidian-git** | free | no | poor on mobile | line-level (git) | medium |
| **Syncthing** | free | in transit | Android only | file-level | medium |

- Choose **Google Drive (this plugin)** if you already live in Google's ecosystem and want free sync plus a browsable copy of your vault in Drive.
- Choose **Obsidian Sync** if you want the most reliable, zero-maintenance option with end-to-end encryption and fine-grained merge — it's the only option that merges concurrent edits *within* a file.
- Choose **obsidian-git** if you want full history and mostly work on desktop.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # type-check + production bundle
```

Source layout: `src/main.ts` (plugin lifecycle), `src/auth.ts` (OAuth PKCE loopback flow), `src/driveClient.ts` (Drive v3 REST), `src/sync.ts` (three-way sync engine), `src/settings.ts` (settings UI).

## License

MIT
