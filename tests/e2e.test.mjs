import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { FakeDrive, makeDevice } from "./fakes.mjs";

const require = createRequire(import.meta.url);
const { performSync, MARKER_NAME, VaultMismatchError } = require("./build/sync.cjs");
const { hasEncryptionMagic } = require("./build/crypto.cjs");

const sync = (device) => performSync(device.ctx, device.opts);

test("e2e: initial upload, then steady-state syncs take the fast path", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	a.io.setText("hello.md", "hi");
	a.io.setText("notes/deep/nested.md", "content");

	const first = await sync(a);
	assert.equal(first.uploaded, 2);
	assert.equal(first.errors.length, 0);
	assert.equal(first.fastPath, false);
	assert.deepEqual(await drive.snapshot(a.data.baseFolderId), {
		"hello.md": "hi",
		"notes/deep/nested.md": "content",
	});

	const before = drive.listTreeCalls;
	const second = await sync(a);
	assert.equal(second.fastPath, true, "no-op sync should use the Changes API fast path");
	assert.equal(second.uploaded + second.downloaded, 0);
	assert.equal(drive.listTreeCalls, before, "fast path must not re-list the Drive tree");
});

test("e2e: changes propagate between two devices", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	const b = makeDevice(drive);
	a.io.setText("shared.md", "v1");
	await sync(a);

	const bFirst = await sync(b);
	assert.equal(bFirst.downloaded, 1);
	assert.equal(b.io.getText("shared.md"), "v1");

	b.io.setText("shared.md", "v2 from B");
	await sync(b);
	const aPull = await sync(a);
	assert.equal(aPull.downloaded, 1);
	assert.equal(aPull.fastPath, false, "a remote edit must force a full listing");
	assert.equal(a.io.getText("shared.md"), "v2 from B");
});

test("e2e: fast path still uploads local edits without listing the tree", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	a.io.setText("note.md", "one");
	await sync(a);

	a.io.setText("note.md", "two");
	const before = drive.listTreeCalls;
	const report = await sync(a);
	assert.equal(report.fastPath, true);
	assert.equal(report.uploaded, 1);
	assert.equal(drive.listTreeCalls, before);
	assert.equal((await drive.snapshot(a.data.baseFolderId))["note.md"], "two");
});

test("e2e: concurrent edits to different lines auto-merge through the full pipeline", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	const b = makeDevice(drive);
	a.io.setText("doc.md", "alpha\nbeta\ngamma");
	await sync(a);
	await sync(b); // B now has the base version

	a.io.setText("doc.md", "ALPHA\nbeta\ngamma"); // A edits line 1
	await sync(a);
	b.io.setText("doc.md", "alpha\nbeta\nGAMMA"); // B edits line 3, unaware of A
	const bReport = await sync(b);
	assert.equal(bReport.merged, 1, "conflict should be auto-merged");
	assert.equal(b.io.getText("doc.md"), "ALPHA\nbeta\nGAMMA");

	const aReport = await sync(a);
	assert.equal(aReport.downloaded, 1);
	assert.equal(a.io.getText("doc.md"), "ALPHA\nbeta\nGAMMA");
});

test("e2e: same-line edits fall back to a conflict copy, losing nothing", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	const b = makeDevice(drive);
	a.io.setText("doc.md", "original");
	await sync(a);
	await sync(b);

	a.io.setText("doc.md", "A version");
	await sync(a);
	b.io.setText("doc.md", "B version");
	const report = await sync(b);
	assert.equal(report.merged, 0);
	assert.equal(report.conflicts, 1);
	assert.equal(b.io.getText("doc.md"), "B version", "local version stays in place");
	const conflictCopies = [...b.io.files.keys()].filter((p) => p.includes("(conflict"));
	assert.equal(conflictCopies.length, 1);
	assert.equal(b.io.getText(conflictCopies[0]), "A version", "remote version saved alongside");
});

test("e2e: local rename becomes a Drive move — same file id, no re-upload", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	a.io.setText("old-name.md", "stable content");
	await sync(a);
	const idBefore = a.data.state["old-name.md"].remoteId;

	a.io.renameFile("old-name.md", "folder/new-name.md");
	const report = await sync(a);
	assert.equal(report.renamed, 1);
	assert.equal(report.uploaded, 0, "rename must not re-upload content");
	assert.equal(a.data.state["folder/new-name.md"].remoteId, idBefore, "Drive file id preserved");
	assert.deepEqual(await drive.snapshot(a.data.baseFolderId), { "folder/new-name.md": "stable content" });
});

test("e2e: remote rename applied locally without any transfer", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	const b = makeDevice(drive);
	a.io.setText("original.md", "content");
	await sync(a);
	await sync(b);

	a.io.renameFile("original.md", "renamed.md");
	await sync(a);

	const report = await sync(b);
	assert.equal(report.renamed, 1);
	assert.equal(report.downloaded, 0);
	assert.equal(b.io.getText("renamed.md"), "content");
	assert.equal(b.io.getText("original.md"), null);
});

test("e2e: deletions propagate in both directions", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	const b = makeDevice(drive);
	a.io.setText("keep.md", "k");
	a.io.setText("remove.md", "r");
	await sync(a);
	await sync(b);

	a.io.deleteFile("remove.md");
	const aReport = await sync(a);
	assert.equal(aReport.deletedRemote, 1);

	const bReport = await sync(b);
	assert.equal(bReport.deletedLocal, 1);
	assert.equal(b.io.getText("remove.md"), null);
	assert.equal(b.io.getText("keep.md"), "k");
});

test("e2e: deletion guard blocks a mass wipe when declined, proceeds when confirmed", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive, { opts: { deletionGuardThreshold: 5 } });
	for (let i = 0; i < 8; i++) a.io.setText(`n${i}.md`, `note ${i}`);
	await sync(a);

	for (let i = 0; i < 8; i++) a.io.deleteFile(`n${i}.md`);
	let asked = null;
	a.ctx.confirmDeletions = async (paths) => {
		asked = paths.length;
		return false;
	};
	const declined = await sync(a);
	assert.equal(asked, 8, "guard should have asked about all 8 deletions");
	assert.equal(declined.aborted, true);
	assert.equal(Object.keys(await drive.snapshot(a.data.baseFolderId)).length, 8, "Drive untouched after decline");

	a.ctx.confirmDeletions = async () => true;
	const confirmed = await sync(a);
	assert.equal(confirmed.deletedRemote, 8);
	assert.deepEqual(await drive.snapshot(a.data.baseFolderId), {});
});

test("e2e: vault marker blocks a second vault from clobbering the folder", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	a.io.setText("a.md", "vault A's note");
	await sync(a);

	const intruder = makeDevice(drive);
	intruder.data.vaultId = "a-totally-different-vault";
	intruder.io.setText("other.md", "vault B's note");
	await assert.rejects(() => sync(intruder), VaultMismatchError);
	assert.equal((await drive.snapshot(a.data.baseFolderId))["other.md"], undefined);
});

test("e2e: encryption — ciphertext on Drive, plaintext on both devices", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive, { opts: { encryptionPassword: "hunter2" } });
	a.io.setText("secret.md", "my secret note");
	await sync(a);

	const raw = drive.rawBytes(a.data.baseFolderId, "secret.md");
	assert.equal(hasEncryptionMagic(raw), true, "bytes on Drive must be encrypted");
	assert.ok(!new TextDecoder().decode(raw).includes("my secret note"));

	const b = makeDevice(drive, { opts: { encryptionPassword: "hunter2" } });
	const bReport = await sync(b);
	assert.equal(bReport.errors.length, 0);
	assert.equal(b.io.getText("secret.md"), "my secret note");

	const noPassword = makeDevice(drive);
	const failed = await sync(noPassword);
	assert.equal(failed.downloaded, 0);
	assert.match(failed.errors[0] ?? "", /encrypt/i);
});

test("e2e: dry run reports the plan and touches nothing", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	a.io.setText("one.md", "1");
	a.io.setText("two.md", "2");
	a.opts.dryRun = true;
	const result = await sync(a);
	assert.equal(result.plan.actions.length, 2);
	assert.ok(result.plan.actions.every((x) => x.type === "upload-new"));
	assert.deepEqual(await drive.snapshot(a.data.baseFolderId), {}, "dry run must not upload");
	assert.deepEqual(a.data.state, {});
});

test("e2e: marker file never leaks into the synced files", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	a.io.setText("n.md", "x");
	await sync(a);
	const b = makeDevice(drive);
	await sync(b);
	assert.equal(b.io.getText(MARKER_NAME), null, "marker must not be downloaded as a note");
	assert.equal(b.data.vaultId, a.data.vaultId, "second device adopts the vault id");
});

test("e2e: interleaved edits across many files, both directions in one sync", async () => {
	const drive = new FakeDrive();
	const a = makeDevice(drive);
	const b = makeDevice(drive);
	for (let i = 0; i < 30; i++) a.io.setText(`f${i}.md`, `v1-${i}`);
	await sync(a);
	await sync(b);

	// A edits evens; B edits odds and adds new files; then B syncs first.
	for (let i = 0; i < 30; i += 2) a.io.setText(`f${i}.md`, `A-${i}`);
	for (let i = 1; i < 30; i += 2) b.io.setText(`f${i}.md`, `B-${i}`);
	b.io.setText("brand-new.md", "from B");
	await sync(b);

	const aReport = await sync(a);
	assert.equal(aReport.errors.length, 0);
	assert.equal(aReport.uploaded, 15, "A's 15 even-file edits upload");
	assert.equal(aReport.downloaded, 16, "B's 15 odd edits + 1 new file download");

	const bReport = await sync(b);
	assert.equal(bReport.errors.length, 0);
	for (let i = 0; i < 30; i++) {
		const expected = i % 2 === 0 ? `A-${i}` : `B-${i}`;
		assert.equal(a.io.getText(`f${i}.md`), expected);
		assert.equal(b.io.getText(`f${i}.md`), expected);
	}
});
