import { Notice, Platform } from "obsidian";
import { AuthTokens } from "./types";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface OAuthClientConfig {
	clientId: string;
	clientSecret: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafeString(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64UrlEncode(new Uint8Array(digest));
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	error?: string;
	error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
	// fetch (not requestUrl) is fine here: Google's token endpoint sends CORS
	// headers, and this also works in the loopback flow on desktop.
	const resp = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const json = (await resp.json()) as TokenResponse;
	if (!resp.ok || json.error) {
		throw new Error(`Token request failed: ${json.error ?? resp.status} ${json.error_description ?? ""}`);
	}
	return json;
}

/**
 * Runs the OAuth "installed app" loopback flow: starts a temporary HTTP server
 * on 127.0.0.1, opens the consent page in the system browser, and exchanges
 * the returned code (with PKCE) for tokens. Desktop only — mobile Obsidian has
 * no Node http module; mobile users import auth exported from desktop instead.
 */
export async function authenticate(config: OAuthClientConfig): Promise<AuthTokens> {
	if (!Platform.isDesktopApp) {
		throw new Error(
			"Sign-in must be done on desktop. Connect there, then use “Export auth” / “Import auth” in settings to bring the connection to this device."
		);
	}
	if (!config.clientId || !config.clientSecret) {
		throw new Error("Set your Google OAuth Client ID and Client Secret in the plugin settings first (see README).");
	}

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const http = require("http") as typeof import("http");

	const verifier = randomUrlSafeString(48);
	const challenge = await pkceChallenge(verifier);
	const expectedState = randomUrlSafeString(16);

	return new Promise<AuthTokens>((resolve, reject) => {
		const server = http.createServer(async (req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				if (url.pathname !== "/callback") {
					res.writeHead(404).end();
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const err = url.searchParams.get("error");

				res.writeHead(200, { "Content-Type": "text/html" });
				if (err || !code || state !== expectedState) {
					res.end("<h3>Sign-in failed. You can close this window and try again in Obsidian.</h3>");
					finish(new Error(err ?? "No authorization code returned"));
					return;
				}
				res.end("<h3>Connected to Google Drive. You can close this window and return to Obsidian.</h3>");

				const address = server.address();
				const port = typeof address === "object" && address ? address.port : 0;
				const token = await tokenRequest({
					code,
					client_id: config.clientId,
					client_secret: config.clientSecret,
					redirect_uri: `http://127.0.0.1:${port}/callback`,
					grant_type: "authorization_code",
					code_verifier: verifier,
				});
				if (!token.refresh_token) {
					finish(new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again."));
					return;
				}
				finish(null, {
					accessToken: token.access_token,
					refreshToken: token.refresh_token,
					expiresAt: Date.now() + token.expires_in * 1000,
				});
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});

		const timeout = setTimeout(() => {
			finish(new Error("Timed out waiting for Google sign-in (5 minutes)."));
		}, 5 * 60 * 1000);

		let done = false;
		function finish(error: Error | null, tokens?: AuthTokens) {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			server.close();
			if (error) reject(error);
			else resolve(tokens as AuthTokens);
		}

		server.on("error", (e) => finish(e));
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const params = new URLSearchParams({
				client_id: config.clientId,
				redirect_uri: `http://127.0.0.1:${port}/callback`,
				response_type: "code",
				scope: DRIVE_SCOPE,
				access_type: "offline",
				prompt: "consent",
				state: expectedState,
				code_challenge: challenge,
				code_challenge_method: "S256",
			});
			const authUrl = `${AUTH_ENDPOINT}?${params.toString()}`;
			window.open(authUrl);
			new Notice("Complete the Google sign-in in your browser…");
		});
	});
}

/** Refreshes the access token if it expires within the next minute. */
export async function ensureFreshTokens(config: OAuthClientConfig, tokens: AuthTokens): Promise<AuthTokens> {
	if (Date.now() < tokens.expiresAt - 60_000) return tokens;
	const resp = await tokenRequest({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		refresh_token: tokens.refreshToken,
		grant_type: "refresh_token",
	});
	return {
		accessToken: resp.access_token,
		refreshToken: resp.refresh_token ?? tokens.refreshToken,
		expiresAt: Date.now() + resp.expires_in * 1000,
	};
}
