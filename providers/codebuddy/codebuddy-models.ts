/**
 * CodeBuddy International static model catalog and wire identity.
 *
 * The chat gateway (https://www.codebuddy.ai/v2/chat/completions) speaks
 * OpenAI Chat Completions over SSE but publishes no `/models` list, so the
 * catalog is static. Model ids and limits follow the CodeBuddy IDE plugin's
 * product config. Ids without published limits use conservative defaults.
 *
 * Every model draws from the account's free monthly credit quota (paid plans
 * only add credits), so the catalog is stamped authoritatively free.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Headers the gateway expects from the CodeBuddy IDE plugin. */
export const CODEBUDDY_IDENTITY_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
	"X-Product": "SaaS",
	"X-IDE-Type": "IDE",
	"X-IDE-Name": "IDE",
	"X-Requested-With": "XMLHttpRequest",
	"X-CodeBuddy-Request": "1",
};

interface CatalogEntry {
	id: string;
	name: string;
	vision?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_000;

const CATALOG: readonly CatalogEntry[] = [
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		vision: true,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		vision: true,
		contextWindow: 200_000,
		maxTokens: 48_000,
	},
	{ id: "glm-5.0", name: "GLM-5.0", contextWindow: 200_000, maxTokens: 48_000 },
	{ id: "glm-5.0-turbo", name: "GLM-5.0-Turbo" },
	{ id: "glm-5v-turbo", name: "GLM-5v-Turbo", vision: true },
	{ id: "glm-4.7", name: "GLM-4.7", contextWindow: 200_000, maxTokens: 48_000 },
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		vision: true,
		contextWindow: 512_000,
		maxTokens: 131_072,
	},
	{ id: "minimax-m2.7", name: "MiniMax-M2.7" },
	{ id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
	{ id: "kimi-k2.6", name: "Kimi-K2.6" },
	{
		id: "kimi-k2.5",
		name: "Kimi-K2.5",
		vision: true,
		contextWindow: 164_000,
		maxTokens: 32_000,
	},
	{
		id: "hy3-preview",
		name: "Hy3 Preview",
		vision: true,
		contextWindow: 192_000,
		maxTokens: 64_000,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek-V4-Pro",
		vision: true,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek-V4.1-Flash",
		vision: true,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "deepseek-v3-2-volc",
		name: "DeepSeek-V3.2",
		contextWindow: 96_000,
		maxTokens: 32_000,
	},
];

type CodebuddyModel = ProviderModelConfig & {
	_freeKnown?: boolean;
	_isFree?: boolean;
};

function toModel(entry: CatalogEntry): CodebuddyModel {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: true,
		input: entry.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
		headers: { ...CODEBUDDY_IDENTITY_HEADERS },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			maxTokensField: "max_tokens",
		},
		_freeKnown: true,
		_isFree: true,
	};
}

/** The full static CodeBuddy catalog. */
export function getCodebuddyModels(): ProviderModelConfig[] {
	return CATALOG.map(toModel);
}
