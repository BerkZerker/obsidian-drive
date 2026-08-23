import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEncryptionCodec, plaintextCodec, generateSaltB64, hasEncryptionMagic } = require("./build/crypto.cjs");

const text = (s) => new TextEncoder().encode(s).buffer;
const fromBuf = (b) => new TextDecoder().decode(b);

test("encrypt/decrypt roundtrip", async () => {
	const salt = generateSaltB64();
	const codec = await createEncryptionCodec("correct horse battery staple", salt);
	const original = "# Secret note\nwith several lines\nand ünïcode ✓";
	const encrypted = await codec.encode(text(original));
	assert.equal(hasEncryptionMagic(encrypted), true);
	assert.notEqual(fromBuf(encrypted), original);
	const decrypted = await codec.decode(encrypted);
	assert.equal(fromBuf(decrypted), original);
});

test("same content encrypts differently each time (random IV)", async () => {
	const salt = generateSaltB64();
	const codec = await createEncryptionCodec("pw", salt);
	const a = new Uint8Array(await codec.encode(text("same")));
	const b = new Uint8Array(await codec.encode(text("same")));
	assert.notDeepEqual([...a], [...b]);
});

test("wrong password throws a clear error", async () => {
	const salt = generateSaltB64();
	const good = await createEncryptionCodec("right", salt);
	const bad = await createEncryptionCodec("wrong", salt);
	const encrypted = await good.encode(text("data"));
	await assert.rejects(() => bad.decode(encrypted), /password/i);
});

test("different salt derives a different key", async () => {
	const codecA = await createEncryptionCodec("pw", generateSaltB64());
	const codecB = await createEncryptionCodec("pw", generateSaltB64());
	const encrypted = await codecA.encode(text("data"));
	await assert.rejects(() => codecB.decode(encrypted));
});

test("encryption codec passes through plaintext files (migration)", async () => {
	const codec = await createEncryptionCodec("pw", generateSaltB64());
	const plain = text("uploaded before encryption was on");
	assert.equal(fromBuf(await codec.decode(plain)), "uploaded before encryption was on");
});

test("plaintext codec passes data through untouched", async () => {
	const data = text("hello");
	assert.equal(await plaintextCodec.decode(data), data);
	assert.equal(await plaintextCodec.encode(data), data);
});

test("plaintext codec refuses encrypted files with a helpful error", async () => {
	const codec = await createEncryptionCodec("pw", generateSaltB64());
	const encrypted = await codec.encode(text("secret"));
	await assert.rejects(() => plaintextCodec.decode(encrypted), /encryption password/i);
});
