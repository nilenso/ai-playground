import type { Message } from "@mariozechner/pi-ai";
import type { AskOptions, AskResult, Session } from "@nilenso/ask-forge";
import { createMessage, getMessagesBySession, getSession, updateSessionStatus, updateSessionTitle } from "./db.ts";

function persistMessage(sessionId: string, ordinal: number, msg: Message): void {
	switch (msg.role) {
		case "user": {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			createMessage({ sessionId, role: "user", ordinal, content });
			break;
		}
		case "assistant": {
			// Serialize the full content array as JSON to preserve all tool calls and thinking blocks
			const content = JSON.stringify(msg.content);
			createMessage({ sessionId, role: "assistant", ordinal, content });
			break;
		}
		case "toolResult": {
			const contentText = msg.content.map((c) => ("text" in c ? c.text : "")).join("");
			createMessage({
				sessionId,
				role: "tool",
				ordinal,
				content: contentText,
				toolName: msg.toolName,
				toolArguments: msg.toolCallId,
				toolResult: contentText,
			});
			break;
		}
	}
}

export function wrapSession(session: Session, sessionId: string): Session {
	const existingSession = getSession(sessionId);
	let hasTitle = !!existingSession?.title;
	const dbMessages = getMessagesBySession(sessionId);
	let ordinal = dbMessages.length;

	// Backfill title from first user message if missing
	if (!hasTitle && dbMessages.length > 0) {
		const firstUserMsg = dbMessages.find((m) => m.role === "user");
		if (firstUserMsg?.content) {
			const title = firstUserMsg.content.length > 80 ? `${firstUserMsg.content.slice(0, 77)}...` : firstUserMsg.content;
			updateSessionTitle(sessionId, title);
			hasTitle = true;
		}
	}

	const persistMessages = () => {
		const messages: Message[] = session.getMessages();
		// Persist only new messages (from ordinal onward)
		for (let i = ordinal; i < messages.length; i++) {
			persistMessage(sessionId, i, messages[i]);
		}
		ordinal = messages.length;
	};

	const wrapped = {
		id: sessionId,
		repo: session.repo,

		async ask(question: string, options?: AskOptions): Promise<AskResult> {
			// Persist user message immediately so it's available if user switches away
			createMessage({ sessionId, role: "user", ordinal, content: question });
			ordinal++;

			// Auto-set session title from first question (skip if already titled, e.g. restored sessions)
			if (!hasTitle) {
				const title = question.length > 80 ? `${question.slice(0, 77)}...` : question;
				updateSessionTitle(sessionId, title);
				hasTitle = true;
			}

			try {
				const result = await session.ask(question, options);

				if (result.response.startsWith("[ERROR:")) {
					updateSessionStatus(sessionId, "error");
				}

				return result;
			} catch (err) {
				updateSessionStatus(sessionId, "error");
				throw err;
			} finally {
				persistMessages();
			}
		},

		replaceMessages(messages: Parameters<Session["replaceMessages"]>[0]) {
			session.replaceMessages(messages);
		},

		getMessages() {
			return session.getMessages();
		},

		close() {
			session.close();
		},
	};

	return wrapped;
}
