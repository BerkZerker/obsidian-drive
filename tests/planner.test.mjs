import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planSync } = require("./build/planner.cjs");

/**
 * Test harness: describe local/remote/state worlds compactly.
 * localFiles: { path: { mtime, size, hash, changed } }
 * remoteFiles: { path: { id, md5 } }
 * state: { path: { remoteId, localHash, remoteMd5, mtime, size } }
 */
function makeInput({ local = {}, remote = {}, state = {} }) {
	return {
		local: new Map(Object.entries(local).map(([p, f]) => [p, { mtime: f.mtime ?? 1, size: f.size ?? 10 }])),
		remote: new Map(
			Object.entries(remote).map(([p, f]) => [p, { id: f.id, md5: f.md5, modifiedTime: f.modifiedTime ?? 0 }])
		),
		state,
		async isLocalChanged(path) {
			return local[path]?.changed ?? true;
		},
		async localHash(path) {
			return local[path]?.hash ?? "h-" + path;
		},
	};
}

function types(plan) {
	return plan.actions.map((a) => a.type).sort();
}

test("everything in sync → no actions", async () => {
	const input = makeInput({
		local: { "a.md": { changed: false } },
		remote: { "a.md": { id: "1", md5: "m1" } },
		state: { "a.md": { remoteId: "1", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
	});
	const plan = await planSync(input);
	assert.deepEqual(plan.actions, []);
	assert.equal(plan.unchanged, 1);
});

test("new local file → upload-new", async () => {
	const plan = await planSync(makeInput({ local: { "new.md": {} } }));
	assert.deepEqual(types(plan), ["upload-new"]);
});

test("new remote file → download", async () => {
	const plan = await planSync(makeInput({ remote: { "new.md": { id: "9", md5: "x" } } }));
	assert.deepEqual(types(plan), ["download"]);
});

test("local edit → upload-update; remote edit → download", async () => {
	const state = {
		"a.md": { remoteId: "1", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 },
		"b.md": { remoteId: "2", localHash: "h", remoteMd5: "m2", mtime: 1, size: 10 },
	};
	const plan = await planSync(
		makeInput({
			local: { "a.md": { changed: true }, "b.md": { changed: false } },
			remote: { "a.md": { id: "1", md5: "m1" }, "b.md": { id: "2", md5: "m2-CHANGED" } },
			state,
		})
	);
	assert.deepEqual(types(plan), ["download", "upload-update"]);
});

test("both changed → conflict", async () => {
	const plan = await planSync(
		makeInput({
			local: { "a.md": { changed: true } },
			remote: { "a.md": { id: "1", md5: "new-md5" } },
			state: { "a.md": { remoteId: "1", localHash: "h", remoteMd5: "old-md5", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["conflict"]);
});

test("deleted locally, unchanged remotely → delete-remote", async () => {
	const plan = await planSync(
		makeInput({
			remote: { "gone.md": { id: "1", md5: "m1" } },
			state: { "gone.md": { remoteId: "1", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["delete-remote"]);
	assert.deepEqual(plan.deletionPaths, ["gone.md"]);
});

test("deleted locally but edited remotely → restore (download)", async () => {
	const plan = await planSync(
		makeInput({
			remote: { "gone.md": { id: "1", md5: "EDITED" } },
			state: { "gone.md": { remoteId: "1", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["download"]);
});

test("deleted remotely, unchanged locally → delete-local", async () => {
	const plan = await planSync(
		makeInput({
			local: { "gone.md": { changed: false } },
			state: { "gone.md": { remoteId: "1", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["delete-local"]);
});

test("deleted remotely but edited locally → re-upload", async () => {
	const plan = await planSync(
		makeInput({
			local: { "gone.md": { changed: true } },
			state: { "gone.md": { remoteId: "1", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["upload-new"]);
});

test("new on both sides → inspect", async () => {
	const plan = await planSync(
		makeInput({
			local: { "both.md": {} },
			remote: { "both.md": { id: "1", md5: "m" } },
		})
	);
	assert.deepEqual(types(plan), ["inspect"]);
});

test("gone everywhere → forget stale state", async () => {
	const plan = await planSync(
		makeInput({ state: { "old.md": { remoteId: "1", localHash: "h", remoteMd5: "m", mtime: 1, size: 1 } } })
	);
	assert.deepEqual(types(plan), ["forget"]);
});

test("local rename detected → rename-remote, no transfer", async () => {
	const plan = await planSync(
		makeInput({
			local: { "renamed.md": { hash: "SAME-HASH" } },
			remote: { "original.md": { id: "1", md5: "m1" } },
			state: { "original.md": { remoteId: "1", localHash: "SAME-HASH", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["rename-remote"]);
	const action = plan.actions[0];
	assert.equal(action.from, "original.md");
	assert.equal(action.to, "renamed.md");
	assert.equal(action.remoteId, "1");
	assert.deepEqual(plan.deletionPaths, []); // renames don't count as deletions
});

test("remote rename detected by Drive id → rename-local, no transfer", async () => {
	const plan = await planSync(
		makeInput({
			local: { "old-name.md": { changed: false } },
			remote: { "new-name.md": { id: "77", md5: "m1" } },
			state: { "old-name.md": { remoteId: "77", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["rename-local"]);
	const action = plan.actions[0];
	assert.equal(action.from, "old-name.md");
	assert.equal(action.to, "new-name.md");
});

test("remote rename WITH edit falls back to download + delete-local", async () => {
	const plan = await planSync(
		makeInput({
			local: { "old-name.md": { changed: false } },
			remote: { "new-name.md": { id: "77", md5: "m1-EDITED" } },
			state: { "old-name.md": { remoteId: "77", localHash: "h", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["delete-local", "download"]);
});

test("different content is NOT treated as a rename", async () => {
	const plan = await planSync(
		makeInput({
			local: { "b.md": { hash: "DIFFERENT" } },
			remote: { "a.md": { id: "1", md5: "m1" } },
			state: { "a.md": { remoteId: "1", localHash: "ORIGINAL", remoteMd5: "m1", mtime: 1, size: 10 } },
		})
	);
	assert.deepEqual(types(plan), ["delete-remote", "upload-new"]);
});

test("deletion paths counted for the guard", async () => {
	const state = {};
	const remote = {};
	for (let i = 0; i < 12; i++) {
		state[`n${i}.md`] = { remoteId: `id${i}`, localHash: "h", remoteMd5: "m", mtime: 1, size: 1 };
		remote[`n${i}.md`] = { id: `id${i}`, md5: "m" };
	}
	const plan = await planSync(makeInput({ remote, state })); // all locally deleted
	assert.equal(plan.deletionPaths.length, 12);
});
