/**
 * Request shaping for the CodeBuddy chat gateway.
 *
 * The gateway accepts the OpenAI Chat Completions shape with three quirks,
 * matching what the IDE plugin sends:
 *
 *   - streaming only: non-stream requests are rejected;
 *   - the conversation must open with the CodeBuddy identity system prompt,
 *     and a bare string user `content` is rejected with `11101 invalid
 *     request`, so string user content is sent as a typed text block;
 *   - reasoning summaries are only streamed back when `reasoning_summary`
 *     accompanies `reasoning_effort`.
 *
 * Pi's own system prompt is kept: it is folded into the single leading
 * system message after the identity line, so tool and project instructions
 * still reach the model.
 */

const IDENTITY_PROMPT = "You are CodeBuddy Code.";

interface ChatMessage {
	role?: string;
	content?: unknown;
	[key: string]: unknown;
}

interface ChatPayload {
	messages?: ChatMessage[];
	stream?: boolean;
	reasoning_effort?: string;
	reasoning_summary?: string;
	[key: string]: unknown;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: unknown }) =>
			part?.type === "text" && typeof part.text === "string" ? part.text : "",
		)
		.filter(Boolean)
		.join("\n");
}

function isSystemRole(message: ChatMessage): boolean {
	return message.role === "system" || message.role === "developer";
}

function shapeMessages(messages: ChatMessage[]): ChatMessage[] {
	const systemText = messages
		.filter(isSystemRole)
		.map((message) => contentText(message.content))
		.filter(Boolean);
	const system: ChatMessage = {
		role: "system",
		content: [IDENTITY_PROMPT, ...systemText].join("\n\n"),
	};
	const rest = messages
		.filter((message) => !isSystemRole(message))
		.map((message) =>
			message.role === "user" && typeof message.content === "string"
				? { ...message, content: [{ type: "text", text: message.content }] }
				: message,
		);
	return [system, ...rest];
}

/** Rewrite an OpenAI Chat Completions payload into the shape CodeBuddy accepts. */
export function shapeCodebuddyPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const body = { ...(payload as ChatPayload) };
	body.stream = true;
	if (Array.isArray(body.messages)) {
		body.messages = shapeMessages(body.messages);
	}
	const effort = body.reasoning_effort;
	if (effort === "none" || effort === "off") {
		delete body.reasoning_effort;
	} else if (effort) {
		body.reasoning_summary = "auto";
	}
	return body;
}
