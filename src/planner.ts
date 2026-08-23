import { SyncState } from "./types";

/**
 * Pure sync planner: given metadata about local files, remote files, and the
 * last-synced snapshot, decides what a sync should do. No I/O of its own —
 * hashing is delegated to callbacks — so it is fully unit-testable.
 */

export interface PlanLocal {
	mtime: number;
	size: number;
}

export interface PlanRemote {
	id: string;
	md5: string;
	modifiedTime: number;
}

export type PlanAction =
	| { type: "upload-new"; path: string }
	| { type: "upload-update"; path: string; remoteId: string }
	| { type: "download"; path: string; remote: PlanRemote }
	| { type: "delete-local"; path: string }
	| { type: "delete-remote"; path: string; remoteId: string }
	| { type: "conflict"; path: string; remote: PlanRemote }
	/** Present on both sides with no sync history: compare content, then adopt or conflict. */
	| { type: "inspect"; path: string; remote: PlanRemote }
	/** File was renamed/moved locally: rename it on Drive instead of delete+reupload. */
	| { type: "rename-remote"; from: string; to: string; remoteId: string }
	/** File was renamed/moved on Drive: rename it locally instead of download+delete. */
	| { type: "rename-local"; from: string; to: string; remote: PlanRemote }
	/** Content unchanged but the Drive file id changed (file was recreated). */
	| { type: "refresh-id"; path: string; remoteId: string }
	/** Gone on both sides; drop the stale state entry. */
	| { type: "forget"; path: string };

export interface PlanInput {
	local: Map<string, PlanLocal>;
	remote: Map<string, PlanRemote>;
	state: SyncState;
	/** True when the local file's content differs from the last-synced snapshot. */
	isLocalChanged(path: string): Promise<boolean>;
	/** SHA-256 hex of the local file's current content (used for rename matching). */
	localHash(path: string): Promise<string>;
}

export interface SyncPlan {
	actions: PlanAction[];
	/** Paths that delete-local / delete-remote actions would remove. */
	deletionPaths: string[];
	unchanged: number;
}

export async function planSync(input: PlanInput): Promise<SyncPlan> {
	const { local, remote, state } = input;
	let actions: PlanAction[] = [];
	let unchanged = 0;

	const allPaths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(state)]);

	for (const path of allPaths) {
		const l = local.get(path);
		const r = remote.get(path);
		const s = state[path];

		if (l && r) {
			if (!s) {
				actions.push({ type: "inspect", path, remote: r });
				continue;
			}
			const localChanged = await input.isLocalChanged(path);
			const remoteChanged = r.md5 !== s.remoteMd5;
			if (localChanged && remoteChanged) actions.push({ type: "conflict", path, remote: r });
			else if (localChanged) actions.push({ type: "upload-update", path, remoteId: r.id });
			else if (remoteChanged) actions.push({ type: "download", path, remote: r });
			else if (s.remoteId !== r.id) actions.push({ type: "refresh-id", path, remoteId: r.id });
			else unchanged++;
		} else if (l && !r) {
			if (!s) actions.push({ type: "upload-new", path });
			else if (await input.isLocalChanged(path)) actions.push({ type: "upload-new", path }); // deleted remotely but edited here → keep it
			else actions.push({ type: "delete-local", path });
		} else if (!l && r) {
			if (!s) actions.push({ type: "download", path, remote: r });
			else if (r.md5 !== s.remoteMd5) actions.push({ type: "download", path, remote: r }); // deleted locally but edited remotely → restore
			else actions.push({ type: "delete-remote", path, remoteId: s.remoteId });
		} else if (s) {
			actions.push({ type: "forget", path });
		}
	}

	actions = await detectRenames(actions, input);

	const deletionPaths = actions
		.filter((a) => a.type === "delete-local" || a.type === "delete-remote")
		.map((a) => (a as { path: string }).path);

	return { actions, deletionPaths, unchanged };
}

/**
 * Pairs create+delete actions that are really renames or moves:
 * - Local rename: a brand-new local file whose content hash matches a file
 *   that vanished locally (and is unchanged on Drive) → rename on Drive,
 *   which is metadata-only and preserves the file's revision history.
 * - Remote rename: a new remote file carrying the same Drive id (and content)
 *   as a file that vanished remotely → rename locally, no transfer at all.
 */
async function detectRenames(actions: PlanAction[], input: PlanInput): Promise<PlanAction[]> {
	const consumed = new Set<PlanAction>();
	const renames: PlanAction[] = [];

	const remoteDeletes = actions.filter(
		(a): a is Extract<PlanAction, { type: "delete-remote" }> => a.type === "delete-remote"
	);
	if (remoteDeletes.length) {
		for (const a of actions) {
			if (a.type !== "upload-new" || input.state[a.path]) continue;
			const hash = await input.localHash(a.path);
			const match = remoteDeletes.find((d) => !consumed.has(d) && input.state[d.path]?.localHash === hash);
			if (match) {
				consumed.add(a);
				consumed.add(match);
				renames.push({ type: "rename-remote", from: match.path, to: a.path, remoteId: match.remoteId });
			}
		}
	}

	const localDeletes = actions.filter(
		(a): a is Extract<PlanAction, { type: "delete-local" }> => a.type === "delete-local"
	);
	if (localDeletes.length) {
		for (const a of actions) {
			if (a.type !== "download" || input.state[a.path]) continue;
			const match = localDeletes.find(
				(d) =>
					!consumed.has(d) &&
					input.state[d.path]?.remoteId === a.remote.id &&
					input.state[d.path]?.remoteMd5 === a.remote.md5
			);
			if (match) {
				consumed.add(a);
				consumed.add(match);
				renames.push({ type: "rename-local", from: match.path, to: a.path, remote: a.remote });
			}
		}
	}

	if (!consumed.size) return actions;
	return actions.filter((a) => !consumed.has(a)).concat(renames);
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
