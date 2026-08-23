/**
 * Optional client-side encryption. File content is encrypted with
 * AES-256-GCM before upload; the key is derived from the user's password via
 * PBKDF2 (310k iterations, SHA-256) with a random per-vault salt stored in
 * the Drive folder's marker file. Filenames stay in plaintext so the Drive
 * folder remains navigable. Uses only Web Crypto — works in Obsidian
 * (desktop + mobile) and Node 20+.
 */

/** "ODS1" + 0x00 — marks a file as encrypted by this plugin. */
const MAGIC = new Uint8Array([0x4f, 0x44, 0x53, 0x31, 0x00]);
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 310_000;

export interface ContentCodec {
	readonly active: boolean;
	encode(data: ArrayBuffer): Promise<ArrayBuffer>;
	decode(data: ArrayBuffer): Promise<ArrayBuffer>;
}

export function hasEncryptionMagic(data: ArrayBuffer): boolean {
	if (data.byteLength < MAGIC.length) return false;
	const head = new Uint8Array(data, 0, MAGIC.length);
	return MAGIC.every((b, i) => head[i] === b);
}

/** Pass-through codec used when no encryption password is set. */
export const plaintextCodec: ContentCodec = {
	active: false,
	async encode(data) {
		return data;
	},
	async decode(data) {
		if (hasEncryptionMagic(data)) {
			throw new Error(
				"This file is encrypted on Drive. Set the encryption password in the Google Drive Sync settings."
			);
		}
		return data;
	},
};

export function generateSaltB64(): string {
	const salt = new Uint8Array(16);
	crypto.getRandomValues(salt);
	let binary = "";
	for (const b of salt) binary += String.fromCharCode(b);
	return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function createEncryptionCodec(password: string, saltB64: string): Promise<ContentCodec> {
	const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveKey",
	]);
	const salt = b64ToBytes(saltB64);
	const key = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);

	return {
		active: true,
		async encode(data) {
			const iv = new Uint8Array(IV_LENGTH);
			crypto.getRandomValues(iv);
			const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
			const out = new Uint8Array(MAGIC.length + IV_LENGTH + ciphertext.byteLength);
			out.set(MAGIC, 0);
			out.set(iv, MAGIC.length);
			out.set(new Uint8Array(ciphertext), MAGIC.length + IV_LENGTH);
			return out.buffer;
		},
		async decode(data) {
			// Files uploaded before encryption was enabled stay readable.
			if (!hasEncryptionMagic(data)) return data;
			const iv = new Uint8Array(data, MAGIC.length, IV_LENGTH);
			const ciphertext = data.slice(MAGIC.length + IV_LENGTH);
			try {
				return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
			} catch {
				throw new Error("Decryption failed — the encryption password doesn't match the one used to upload.");
			}
		},
	};
}
