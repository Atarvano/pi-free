/**
 * Tests for the CodeBuddy International native provider: plugin OAuth,
 * request shaping, and the static catalog.
 */

import type {
	AuthInteraction,
	OAuthCredential,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCodebuddyApiKey = vi.hoisted(() =>
	vi.fn((): string | undefined => undefined),
);
const mockOpenBrowser = vi.hoisted(() => vi.fn());

vi.mock("../config.ts", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../config.ts");
	return {
		...actual,
		getCodebuddyApiKey: () => mockGetCodebuddyApiKey(),
	};
});

vi.mock("../lib/open-browser.ts", () => ({
	openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

vi.mock("../constants.ts", async () => {
	const actual =
		await vi.importActual<Record<string, unknown>>("../constants.ts");
	return { ...actual, CODEBUDDY_POLL_INTERVAL_MS: 1 };
});

import {
	codebuddyAuth,
	loginCodebuddy,
	refreshCodebuddyCredential,
} from "../providers/codebuddy/codebuddy-auth.ts";
import {
	CODEBUDDY_IDENTITY_HEADERS,
	getCodebuddyModels,
} from "../providers/codebuddy/codebuddy-models.ts";
import { shapeCodebuddyPayload } from "../providers/codebuddy/codebuddy-payload.ts";
import { withCodebuddyPayload } from "../providers/codebuddy/codebuddy.ts";

type MockInit = { method?: string; headers: Record<string, string> };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function interaction(): AuthInteraction & { events: unknown[] } {
	const events: unknown[] = [];
	return {
		events,
		notify: (event: unknown) => {
			events.push(event);
		},
		prompt: vi.fn(),
	} as unknown as AuthInteraction & { events: unknown[] };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCodebuddyApiKey.mockReturnValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CodeBuddy plugin OAuth", () => {
	it("exposes both apiKey and oauth auth", () => {
		expect(codebuddyAuth.apiKey).toBeDefined();
		expect(codebuddyAuth.oauth?.name).toBe("CodeBuddy");
	});

	it("polls until the browser sign-in is approved", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					code: 0,
					data: { state: "st-1", authUrl: "https://example.test/login" },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ code: 11217, msg: "pending" }))
			.mockResolvedValueOnce(
				jsonResponse({
					code: 0,
					data: { accessToken: "acc", refreshToken: "ref", expiresIn: 3600 },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const ui = interaction();
		const credential = await loginCodebuddy(ui);

		expect(credential).toMatchObject({
			type: "oauth",
			access: "acc",
			refresh: "ref",
		});
		expect(credential.expires).toBeGreaterThan(Date.now());
		expect(mockOpenBrowser).toHaveBeenCalledWith("https://example.test/login");
		expect(ui.events).toContainEqual(
			expect.objectContaining({
				type: "auth_url",
				url: "https://example.test/login",
			}),
		);

		const [stateUrl, stateInit] = fetchMock.mock.calls[0] as [string, MockInit];
		expect(stateUrl).toBe(
			"https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide",
		);
		expect(stateInit.method).toBe("POST");
		expect(stateInit.headers["X-No-Authorization"]).toBe("true");
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://www.codebuddy.ai/v2/plugin/auth/token?state=st-1",
		);
	});

	it("fails when the sign-in is rejected", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					jsonResponse({
						code: 0,
						data: { state: "st", authUrl: "https://example.test" },
					}),
				)
				.mockResolvedValueOnce(jsonResponse({ code: 500, msg: "denied" })),
		);
		await expect(loginCodebuddy(interaction())).rejects.toThrow(/denied/);
	});

	it("returns a still-valid credential without a network call", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const credential: OAuthCredential = {
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
		};
		await expect(refreshCodebuddyCredential(credential)).resolves.toBe(
			credential,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refreshes an expired token via the X-Refresh-Token header", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ code: 0, data: { accessToken: "new", expiresIn: 60 } }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const next = await refreshCodebuddyCredential({
			type: "oauth",
			access: "old",
			refresh: "keep-me",
			expires: Date.now() - 1,
		});

		expect(next.access).toBe("new");
		expect(next.refresh).toBe("keep-me");
		const [url, init] = fetchMock.mock.calls[0] as [string, MockInit];
		expect(url).toBe("https://www.codebuddy.ai/v2/plugin/auth/token/refresh");
		expect(init.headers["X-Refresh-Token"]).toBe("keep-me");
	});

	it("asks for a new login when refresh fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ code: 401, msg: "expired" })),
		);
		await expect(
			refreshCodebuddyCredential({
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: 0,
			}),
		).rejects.toThrow(/login codebuddy/);
	});
});

describe("CodeBuddy payload shaping", () => {
	it("folds Pi's system prompt behind the CodeBuddy identity line", () => {
		const shaped = shapeCodebuddyPayload({
			model: "glm-5.1",
			stream: false,
			messages: [
				{ role: "system", content: "Pi system prompt" },
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
			],
		}) as {
			stream: boolean;
			messages: Array<{ role: string; content: unknown }>;
		};

		expect(shaped.stream).toBe(true);
		expect(shaped.messages[0]).toEqual({
			role: "system",
			content: "You are CodeBuddy Code.\n\nPi system prompt",
		});
		expect(shaped.messages[1]).toEqual({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
		expect(shaped.messages[2]).toEqual({ role: "assistant", content: "hi" });
		expect(shaped.messages.filter((m) => m.role === "system")).toHaveLength(1);
	});

	it("keeps typed user content untouched", () => {
		const content = [{ type: "text", text: "a" }];
		const shaped = shapeCodebuddyPayload({
			messages: [{ role: "user", content }],
		}) as { messages: Array<{ content: unknown }> };
		expect(shaped.messages[1]?.content).toBe(content);
	});

	it("adds reasoning_summary with an effort and drops a disabled effort", () => {
		expect(
			shapeCodebuddyPayload({ messages: [], reasoning_effort: "high" }),
		).toMatchObject({ reasoning_effort: "high", reasoning_summary: "auto" });
		const off = shapeCodebuddyPayload({
			messages: [],
			reasoning_effort: "none",
		}) as Record<string, unknown>;
		expect(off.reasoning_effort).toBeUndefined();
		expect(off.reasoning_summary).toBeUndefined();
	});

	it("runs the caller's onPayload hook after shaping", async () => {
		const caller = vi.fn((payload: unknown) => ({
			...(payload as object),
			tagged: true,
		}));
		const options = withCodebuddyPayload({ onPayload: caller } as never) as {
			onPayload: (payload: unknown, model: unknown) => Promise<unknown>;
		};
		const result = (await options.onPayload(
			{ messages: [{ role: "user", content: "x" }] },
			{},
		)) as { tagged: boolean; stream: boolean };
		expect(caller).toHaveBeenCalledOnce();
		expect(result.tagged).toBe(true);
		expect(result.stream).toBe(true);
	});
});

describe("CodeBuddy catalog", () => {
	it("stamps identity headers and free flags on every model", () => {
		const models = getCodebuddyModels();
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.headers).toEqual(CODEBUDDY_IDENTITY_HEADERS);
			expect(model).toMatchObject({ _freeKnown: true, _isFree: true });
			expect((model as { compat?: unknown }).compat).toMatchObject({
				supportsDeveloperRole: false,
			});
		}
		expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
	});
});
