import {
	createCompaction,
	createMessage,
	getMessagesBySession,
	getSession,
	updateSessionStatus,
	updateSessionTitle,
} from "./db.ts";
import type { AskOptions, AskStream, Session, StreamEvent, TurnResult } from "./stream-adapter.ts";
import { getTurnText, getTurnThinking, getTurnToolCalls } from "./stream-adapter.ts";

function persistTurn(sessionId: string, ordinal: { value: number }, turn: TurnResult): void {
	const text = getTurnText(turn);
	const thinking = getTurnThinking(turn);
	const toolCalls = getTurnToolCalls(turn);

	// Persist the assistant response as a single message with JSON content
	const content = JSON.stringify(toolCalls.length > 0 ? { text, toolCalls } : text);

	createMessage({
		sessionId,
		role: "assistant",
		ordinal: ordinal.value,
		content,
		thinking: thinking ?? undefined,
	});
	ordinal.value++;

	if (turn.error) {
		updateSessionStatus(sessionId, "error");
	}
}

/**
 * Wraps an AskStream to persist the TurnResult to the DB after completion,
 * and to persist compaction events from the library's stream.
 */
function wrapAskStream(inner: AskStream, sessionId: string, ordinal: { value: number }): AskStream {
	let cachedResult: Promise<TurnResult> | null = null;

	// Create a passthrough async iterator that also handles compaction events
	async function* iterateAndPersistCompaction(): AsyncGenerator<StreamEvent> {
		for await (const event of inner) {
			if (event.type === "compaction") {
				createCompaction({
					sessionId,
					summary: event.summary,
					firstKeptOrdinal: event.firstKeptOrdinal,
					tokensBefore: event.tokensBefore,
					tokensAfter: event.tokensAfter,
					readFiles: event.readFiles,
					modifiedFiles: event.modifiedFiles,
				});
			}
			yield event;
		}
	}

	const wrappedIterator = iterateAndPersistCompaction();

	return {
		[Symbol.asyncIterator]() {
			return wrappedIterator;
		},
		result() {
			if (!cachedResult) {
				cachedResult = inner.result().then((turn) => {
					persistTurn(sessionId, ordinal, turn);
					return turn;
				});
			}
			return cachedResult;
		},
	};
}

export function wrapSession(session: Session, sessionId: string): Session {
	const existingSession = getSession(sessionId);
	let hasTitle = !!existingSession?.title;
	const dbMessages = getMessagesBySession(sessionId);
	const ordinal = { value: dbMessages.length };

	// Backfill title from first user message if missing
	if (!hasTitle && dbMessages.length > 0) {
		const firstUserMsg = dbMessages.find((m) => m.role === "user");
		if (firstUserMsg?.content) {
			const title =
				firstUserMsg.content.length > 80 ? `${firstUserMsg.content.slice(0, 77)}...` : firstUserMsg.content;
			updateSessionTitle(sessionId, title);
			hasTitle = true;
		}
	}

	return {
		id: sessionId,
		repo: session.repo,
		config: session.config,

		ask(prompt: string, options?: AskOptions): AskStream {
			// Persist user message immediately so it's visible if user switches away
			createMessage({ sessionId, role: "user", ordinal: ordinal.value, content: prompt });
			ordinal.value++;

			// Auto-set session title from first question
			if (!hasTitle) {
				const title = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
				updateSessionTitle(sessionId, title);
				hasTitle = true;
			}

			const innerStream = session.ask(prompt, options);
			return wrapAskStream(innerStream, sessionId, ordinal);
		},

		getTurns() {
			return session.getTurns();
		},

		getTurn(id: string) {
			return session.getTurn(id);
		},

		close() {
			session.close();
		},
	};
}
