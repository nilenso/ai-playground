import type { AskOptions, AskStream, Session, StreamEvent, TurnResult } from "@nilenso/megasthenes";
import {
	createCompaction,
	createMessage,
	createTurn,
	getMessagesBySession,
	getSession,
	getTurnsBySession,
	updateSessionStatus,
	updateSessionTitle,
} from "./db.ts";
import { sessionLogger } from "./logger.ts";

/**
 * Public surface of a wrapped session. We intentionally don't claim to be a
 * full `Session` because megasthenes' `Session` exposes turn introspection
 * (`getTurns`, `getTurn`, `getCompactionSummary`) the wrapper doesn't proxy.
 */
export interface WrappedSession {
	id: string;
	repo: Session["repo"];
	ask(prompt: string, options?: AskOptions): AskStream;
	close(): Promise<void>;
}

/**
 * Reduce a `TurnResult` to the legacy `{ response, toolCalls }` shape used
 * by the wire-format `done` event. Concatenates all assistant text and
 * surfaces tool calls with their resolved params.
 */
export function summarizeTurn(turn: TurnResult): {
	response: string;
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
	let response = "";
	const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	for (const step of turn.steps) {
		if (step.type === "text") response += step.text;
		else if (step.type === "tool_call") toolCalls.push({ name: step.name, arguments: step.params });
	}
	return { response, toolCalls };
}

/**
 * Materialize a `TurnResult` into rows of the legacy `messages` table.
 *
 * Each `iteration_start` step opens a fresh assistant message; thinking,
 * text, and tool-call blocks accumulate inside it; tool-call output becomes
 * a separate `tool` row that follows the assistant row.
 *
 * Phase 4 will replace this with native turns-table storage.
 */
function persistTurnSteps(sessionId: string, startOrdinal: number, turn: TurnResult): number {
	let ordinal = startOrdinal;
	let pendingAssistantBlocks: Array<Record<string, unknown>> = [];

	const flushAssistant = () => {
		if (pendingAssistantBlocks.length === 0) return;
		createMessage({
			sessionId,
			role: "assistant",
			ordinal,
			content: JSON.stringify(pendingAssistantBlocks),
		});
		ordinal++;
		pendingAssistantBlocks = [];
	};

	for (const step of turn.steps) {
		switch (step.type) {
			case "iteration_start":
				flushAssistant();
				break;
			case "thinking":
			case "thinking_summary":
				pendingAssistantBlocks.push({ type: "thinking", thinking: step.text });
				break;
			case "text":
				pendingAssistantBlocks.push({ type: "text", text: step.text });
				break;
			case "tool_call":
				pendingAssistantBlocks.push({
					type: "toolCall",
					toolCallId: step.id,
					name: step.name,
					arguments: step.params,
				});
				flushAssistant();
				createMessage({
					sessionId,
					role: "tool",
					ordinal,
					content: step.output,
					toolName: step.name,
					toolArguments: step.id,
					toolResult: step.output,
				});
				ordinal++;
				break;
			// compaction and error steps are surfaced via separate channels
			case "compaction":
			case "error":
				break;
		}
	}
	flushAssistant();

	return ordinal;
}

export function wrapSession(session: Session, sessionId: string): WrappedSession {
	const existingSession = getSession(sessionId);
	let hasTitle = !!existingSession?.title;
	let ordinal = getMessagesBySession(sessionId).length;
	let turnOrdinal = getTurnsBySession(sessionId).length;

	// Backfill title from first user message if missing (e.g., shared/restored sessions)
	if (!hasTitle) {
		const dbMessages = getMessagesBySession(sessionId);
		const firstUserMsg = dbMessages.find((m) => m.role === "user");
		if (firstUserMsg?.content) {
			const title = firstUserMsg.content.length > 80 ? `${firstUserMsg.content.slice(0, 77)}...` : firstUserMsg.content;
			updateSessionTitle(sessionId, title);
			hasTitle = true;
		}
	}

	return {
		id: sessionId,
		repo: session.repo,

		ask(prompt: string, options?: AskOptions): AskStream {
			// Persist user prompt up front so it's visible if the user navigates away mid-turn
			createMessage({ sessionId, role: "user", ordinal, content: prompt });
			ordinal++;

			if (!hasTitle) {
				const title = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
				updateSessionTitle(sessionId, title);
				hasTitle = true;
			}

			const innerStream = session.ask(prompt, options);
			let pendingCompaction: (StreamEvent & { type: "compaction" }) | undefined;

			async function* iterate(): AsyncGenerator<StreamEvent> {
				try {
					for await (const event of innerStream) {
						if (event.type === "compaction") {
							pendingCompaction = event;
						}
						yield event;
					}
				} finally {
					try {
						const turn = await innerStream.result();
						// Native turn persistence — canonical source for `initialTurns` on restore.
						createTurn({
							sessionId,
							turnId: turn.id,
							ordinal: turnOrdinal,
							prompt: turn.prompt,
							stepsJson: JSON.stringify(turn.steps),
							usageJson: JSON.stringify(turn.usage),
							metadataJson: JSON.stringify(turn.metadata),
							errorJson: turn.error ? JSON.stringify(turn.error) : null,
							startedAt: turn.startedAt,
							endedAt: turn.endedAt,
						});
						turnOrdinal++;
						// Legacy messages-table dual-write — kept one release as a safety net for
						// /sessions/:id/messages, /share/:token, and dump-sessions.ts.
						ordinal = persistTurnSteps(sessionId, ordinal, turn);
						if (pendingCompaction) {
							createCompaction({
								sessionId,
								summary: pendingCompaction.summary,
								firstKeptOrdinal: pendingCompaction.firstKeptOrdinal,
								tokensBefore: pendingCompaction.tokensBefore,
								tokensAfter: pendingCompaction.tokensAfter,
								readFiles: pendingCompaction.readFiles,
								modifiedFiles: pendingCompaction.modifiedFiles,
							});
						}
						if (turn.error) {
							updateSessionStatus(sessionId, "error");
						}
					} catch (sideErr) {
						sessionLogger.error("Failed to persist turn for session {sessionId}: {error}", {
							sessionId,
							error: sideErr instanceof Error ? sideErr.message : String(sideErr),
						});
					}
				}
			}

			return {
				[Symbol.asyncIterator]: iterate,
				result: () => innerStream.result(),
			};
		},

		close(): Promise<void> {
			return session.close();
		},
	};
}
