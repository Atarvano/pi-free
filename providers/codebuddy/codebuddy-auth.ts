/**
 * CodeBuddy International (Tencent, https://www.codebuddy.ai) authentication.
 *
 * CodeBuddy has no public device-code endpoint. The IDE plugin signs in with a
 * state-polling flow, and this module mirrors it:
 *
 *   1. POST /v2/plugin/auth/state?platform=ide  -> { state, authUrl }
 *   2. the user opens authUrl in a browser and signs in
 *   3. GET  /v2/plugin/auth/token?state=...     -> code 11217 while pending,
 *                                                  code 0 + tokens once approved
 *   4. POST /v2/plugin/auth/token/refresh with the refresh token in the
 *      X-Refresh-Token header (not the body)
 *
 * Pi owns credential persistence and calls `refresh` under the credential-store
 * lock. A plain API key (CODEBUDDY_API_KEY / `codebuddy_api_key`) is accepted
 * as an alternative to OAuth.
 */

import type {
	AuthInteraction,
	ModelAuth,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "@earendil-works/pi-ai/compat";
import { getCodebuddyApiKey } from "../../config.ts";
import { CODEBUDDY_POLL_INTERVAL_MS } from "../../constants.ts";
import { createNativeApiKeyAuth } from "../../lib/native-provider.ts";
import { openBrowser } from "../../lib/open-browser.ts";

const CODEBUDDY_ORIGIN = "https://www.codebuddy.ai";
const CODEBUDDY_DOMAIN = "www.codebuddy.ai";
const STATE_URL = `${CODEBUDDY_ORIGIN}/v2/plugin/auth/state?platform=ide`;
const TOKEN_URL = `${CODEBUDDY_ORIGIN}/v2/plugin/auth/token`;
const REFRESH_URL = `${CODEBUDDY_ORIGIN}/v2/plugin/auth/token/refresh`;
const AUTH_USER_AGENT = "IDE/2.63.2 CodeBuddy/2.63.2";

/** Plugin response code while the browser sign-in is still pending. */
const CODE_AUTH_PENDING = 11217;
/** Give up on an unanswered sign-in after ten minutes. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Fallback access-token lifetime when the server omits expiresIn. */
const DEFAULT_EXPIRES_IN_S = 24 * 60 * 60;
/** Refresh a little early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface PluginEnvelope<T> {
	code?: number;
	msg?: string;
	data?: T;
}

interface StateData {
	state?: string;
	authUrl?: string;
}

interface TokenData {
	accessToken?: string;
	refreshToken?: string;
	expiresIn?: number;
}

const BASE_HEADERS = {
	Accept: "application/json",
	"User-Agent": AUTH_USER_AGENT,
	"X-Requested-With": "XMLHttpRequest",
	"X-Domain": CODEBUDDY_DOMAIN,
	"X-Product": "SaaS",
} as const;

const ANONYMOUS_HEADERS = {
	...BASE_HEADERS,
	"X-No-Authorization": "true",
	"X-No-User-Id": "true",
	"X-No-Enterprise-Id": "true",
	"X-No-Department-Info": "true",
} as const;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

function toCredential(
	data: TokenData,
	previousRefresh?: string,
): OAuthCredential {
	if (!data.accessToken) {
		throw new Error("CodeBuddy returned no access token");
	}
	const expiresIn = data.expiresIn ?? DEFAULT_EXPIRES_IN_S;
	return {
		type: "oauth",
		access: data.accessToken,
		refresh: data.refreshToken || previousRefresh || "",
		expires: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
	};
}

/** Step 1: ask the plugin endpoint for a login state and browser URL. */
export async function requestCodebuddyLoginState(
	signal?: AbortSignal,
): Promise<{ state: string; authUrl: string }> {
	const response = await fetch(STATE_URL, {
		method: "POST",
		headers: { ...ANONYMOUS_HEADERS, "Content-Type": "application/json" },
		body: "{}",
		signal: signal ?? null,
	});
	if (!response.ok) {
		throw new Error(`CodeBuddy login state request failed: ${response.status}`);
	}
	const body = (await response.json()) as PluginEnvelope<StateData>;
	const state = body.data?.state;
	const authUrl = body.data?.authUrl;
	if (body.code !== 0 || !state || !authUrl) {
		throw new Error(
			`CodeBuddy login state error: ${body.msg ?? "missing state or authUrl"}`,
		);
	}
	return { state, authUrl };
}

/**
 * Step 3: poll once. Returns the token data once approved, or `undefined`
 * while the browser sign-in is still pending.
 */
export async function pollCodebuddyToken(
	state: string,
	signal?: AbortSignal,
): Promise<TokenData | undefined> {
	const response = await fetch(
		`${TOKEN_URL}?state=${encodeURIComponent(state)}`,
		{ method: "GET", headers: ANONYMOUS_HEADERS, signal: signal ?? null },
	);
	if (!response.ok) {
		throw new Error(`CodeBuddy token poll failed: ${response.status}`);
	}
	const body = (await response.json()) as PluginEnvelope<TokenData>;
	if (body.code === 0 && body.data?.accessToken) return body.data;
	if (body.code === CODE_AUTH_PENDING) return undefined;
	throw new Error(`CodeBuddy sign-in failed: ${body.msg ?? body.code}`);
}

/** Run the CodeBuddy plugin sign-in against Pi's native AuthInteraction. */
export async function loginCodebuddy(
	interaction: AuthInteraction,
): Promise<OAuthCredential> {
	interaction.notify({
		type: "progress",
		message: "Requesting CodeBuddy sign-in...",
	});
	const { state, authUrl } = await requestCodebuddyLoginState(
		interaction.signal,
	);
	interaction.notify({
		type: "auth_url",
		url: authUrl,
		instructions: "Sign in to CodeBuddy in your browser",
	});
	openBrowser(authUrl);

	const deadline = Date.now() + LOGIN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		// pi-lens-ignore: await-in-loop
		await abortableSleep(CODEBUDDY_POLL_INTERVAL_MS, interaction.signal);
		const data = await pollCodebuddyToken(state, interaction.signal);
		if (data) {
			interaction.notify({ type: "progress", message: "Login successful!" });
			return toCredential(data);
		}
	}
	throw new Error("CodeBuddy sign-in timed out. Please try again.");
}

/** Exchange the stored refresh token for a fresh access token. */
export async function refreshCodebuddyCredential(
	credential: OAuthCredential,
	signal?: AbortSignal,
): Promise<OAuthCredential> {
	if (credential.expires > Date.now()) return credential;
	if (!credential.refresh) {
		throw new Error(
			"CodeBuddy token expired. Run /login codebuddy to sign in again.",
		);
	}
	const response = await fetch(REFRESH_URL, {
		method: "POST",
		headers: {
			...BASE_HEADERS,
			"Content-Type": "application/json",
			"X-Refresh-Token": credential.refresh,
			"X-Auth-Refresh-Source": "plugin",
		},
		body: "{}",
		signal: signal ?? null,
	});
	if (!response.ok) {
		throw new Error(`CodeBuddy token refresh failed: ${response.status}`);
	}
	const body = (await response.json()) as PluginEnvelope<TokenData>;
	if (body.code !== 0 || !body.data?.accessToken) {
		throw new Error(
			`CodeBuddy token refresh failed: ${body.msg ?? body.code}. Run /login codebuddy.`,
		);
	}
	return toCredential(body.data, credential.refresh);
}

export const codebuddyOAuthAuth: OAuthAuth = {
	name: "CodeBuddy",
	loginLabel: "Sign in with CodeBuddy",
	login: loginCodebuddy,
	refresh: refreshCodebuddyCredential,
	async toAuth(credential: OAuthCredential): Promise<ModelAuth> {
		return { apiKey: credential.access };
	},
};

/** Native auth for CodeBuddy: plugin OAuth sign-in or a CodeBuddy API key. */
export const codebuddyAuth: ProviderAuth = {
	...createNativeApiKeyAuth({
		name: "CodeBuddy API key",
		prompt: "CodeBuddy API key",
		source: "CODEBUDDY_API_KEY",
		getApiKey: getCodebuddyApiKey,
	}),
	oauth: codebuddyOAuthAuth,
};
