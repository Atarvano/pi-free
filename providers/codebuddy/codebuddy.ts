/**
 * CodeBuddy International native provider.
 *
 * CodeBuddy (https://www.codebuddy.ai) is Tencent's coding assistant. Its
 * IDE plugin talks to an OpenAI-compatible SSE chat gateway at
 * `https://www.codebuddy.ai/v2/chat/completions`, and every account gets a
 * free monthly credit quota. Pi owns auth persistence, token refresh, model
 * store, and streaming through the native provider lifecycle; this module
 * only adds the plugin identity headers (per model, see codebuddy-models.ts)
 * and the request shaping in codebuddy-payload.ts.
 *
 * Setup:
 *   /login codebuddy          # plugin OAuth sign-in in the browser
 *   CODEBUDDY_API_KEY=...     # or an API key / codebuddy_api_key in ~/.pi/free.json
 */

import type { ProviderStreams } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCodebuddyApiKey, getCodebuddyShowPaid } from "../../config.ts";
import { BASE_URL_CODEBUDDY, PROVIDER_CODEBUDDY } from "../../constants.ts";
import { lazyOpenAICompletionsApi } from "../../lib/lazy-compat.ts";
import { registerNativeOpenAIProvider } from "../../lib/native-provider.ts";
import { codebuddyAuth } from "./codebuddy-auth.ts";
import { getCodebuddyModels } from "./codebuddy-models.ts";
import { shapeCodebuddyPayload } from "./codebuddy-payload.ts";

const openAiStreams = lazyOpenAICompletionsApi();

type StreamOptionsArg = Parameters<ProviderStreams["stream"]>[2];

/** Chain CodeBuddy's payload shaping in front of any caller onPayload hook. */
export function withCodebuddyPayload<T extends StreamOptionsArg>(
	options: T,
): T {
	const callerHook = options?.onPayload;
	return {
		...options,
		async onPayload(payload, model) {
			const shaped = shapeCodebuddyPayload(payload);
			const next = callerHook ? await callerHook(shaped, model) : undefined;
			return next ?? shaped;
		},
	} as T;
}

export const codebuddyStreams: ProviderStreams = {
	stream(model, context, streamOptions) {
		return openAiStreams.stream(
			model,
			context,
			withCodebuddyPayload(streamOptions),
		);
	},
	streamSimple(model, context, streamOptions) {
		return openAiStreams.streamSimple(
			model,
			context,
			withCodebuddyPayload(streamOptions),
		);
	},
};

export default function codebuddyProvider(pi: ExtensionAPI): Promise<void> {
	registerNativeOpenAIProvider(pi, {
		providerId: PROVIDER_CODEBUDDY,
		name: "CodeBuddy",
		baseUrl: BASE_URL_CODEBUDDY,
		auth: codebuddyAuth,
		getApiKey: getCodebuddyApiKey,
		getShowPaid: getCodebuddyShowPaid,
		initialModels: getCodebuddyModels(),
		fetchModels: () => Promise.resolve(getCodebuddyModels()),
		allowUnauthenticated: true,
		streams: codebuddyStreams,
	});
	return Promise.resolve();
}
