import type { AskOptions, AskResult, Session } from "ask-forge";
import { createMessage, getMessagesBySession, updateSessionTitle } from "./db.ts";

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function wrapSession(session: Session, dbSessionId?: string): Session {
	let askCount = 0;
	let timeoutHandle: Timer | null = null;
	let terminated = false;
	let ordinal = dbSessionId ? getMessagesBySession(dbSessionId).length : 0;

	const persistMessages = () => {
		if (!dbSessionId) return;
		const messages = session.getMessages();
		// Persist only new messages (from ordinal onward)
		for (let i = ordinal; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role === "user") {
				const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
				createMessage({ sessionId: dbSessionId, role: "user", ordinal: i, content });
			} else if (msg.role === "assistant") {
				// Serialize the full content array as JSON to preserve all tool calls and thinking blocks
				const content = JSON.stringify(msg.content);
				createMessage({ sessionId: dbSessionId, role: "assistant", ordinal: i, content });
			} else if (msg.role === "toolResult") {
				const contentText = msg.content.map((c) => ("text" in c ? c.text : "")).join("");
				createMessage({
					sessionId: dbSessionId,
					role: "tool",
					ordinal: i,
					content: contentText,
					toolName: msg.toolName,
					toolArguments: msg.toolCallId,
					toolResult: contentText,
				});
			}
		}
		ordinal = messages.length;
	};

	const endSession = () => {
		if (terminated) return;
		terminated = true;
		if (timeoutHandle) clearTimeout(timeoutHandle);
		session.close();
	};

	const resetTimeout = () => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		timeoutHandle = setTimeout(() => endSession(), INACTIVITY_TIMEOUT_MS);
	};

	resetTimeout();

	const wrapped = {
		id: session.id,
		repo: session.repo,

		async ask(question: string, options?: AskOptions): Promise<AskResult> {
			resetTimeout();
			const result = await session.ask(question, options);

			persistMessages();

			// Auto-set session title from first question
			if (askCount === 0 && dbSessionId) {
				const title = question.length > 80 ? `${question.slice(0, 77)}...` : question;
				updateSessionTitle(dbSessionId, title);
			}
			askCount++;

			if (result.response.startsWith("[ERROR:")) {
				endSession();
			}

			return result;
		},

		replaceMessages(messages: Parameters<Session["replaceMessages"]>[0]) {
			session.replaceMessages(messages);
		},

		getMessages() {
			return session.getMessages();
		},

		close() {
			endSession();
		},
	};

	return wrapped;
}
