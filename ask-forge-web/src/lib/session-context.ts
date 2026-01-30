import type { Message } from "ask-forge";
import type { DbMessage } from "./db.ts";

/**
 * Convert database messages back into pi-ai Message[] for session restoration.
 *
 * Conversion rules:
 * - role "user" → UserMessage with content string
 * - role "assistant" → AssistantMessage with content array (JSON-parsed from DB content column)
 * - role "tool" → ToolResultMessage with toolCallId, toolName, content, isError
 */
export function buildSessionContext(dbMessages: DbMessage[]): Message[] {
	const messages: Message[] = [];

	for (const row of dbMessages) {
		if (row.role === "user") {
			messages.push({
				role: "user",
				content: row.content ?? "",
				timestamp: new Date(row.created_at).getTime(),
			});
		} else if (row.role === "assistant") {
			// The content column stores the full content array as JSON
			let content;
			try {
				content = JSON.parse(row.content ?? "[]");
			} catch {
				// Fallback: treat as plain text
				content = [{ type: "text" as const, text: row.content ?? "" }];
			}

			messages.push({
				role: "assistant",
				content,
				// These fields are required by AssistantMessage but not meaningful for restored messages
				api: "messages" as never,
				provider: "anthropic" as never,
				model: "restored",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: new Date(row.created_at).getTime(),
			});
		} else if (row.role === "tool") {
			messages.push({
				role: "toolResult",
				toolCallId: row.tool_arguments ?? "",
				toolName: row.tool_name ?? "",
				content: [{ type: "text", text: row.tool_result ?? row.content ?? "" }],
				isError: false,
				timestamp: new Date(row.created_at).getTime(),
			});
		}
	}

	return messages;
}
