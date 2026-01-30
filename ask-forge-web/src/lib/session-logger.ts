import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AskOptions, AskResult, Session, ToolCall, Usage } from "ask-forge";
import { createMessage, getMessagesBySession, updateSessionTitle } from "./db.ts";

const SESSIONS_DIR = process.env.SESSION_DIR || "workdir/sessions";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface AskEntry {
	timestamp: number;
	question: string;
	toolCalls: ToolCall[];
	response: string;
	usage: Usage;
	inferenceTimeMs: number;
	feedback?: "like" | "dislike";
}

export function wrapSession(session: Session, dbSessionId?: string): Session {
	const startedAt = Date.now();
	const asks: AskEntry[] = [];
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

	const endSession = (reason: "closed" | "error" | "timeout", error?: string) => {
		if (terminated) return;
		terminated = true;
		if (timeoutHandle) clearTimeout(timeoutHandle);

		mkdirSync(SESSIONS_DIR, { recursive: true });
		const log = {
			sessionId: session.id,
			repo: { url: session.repo.url, commitish: session.repo.commitish },
			startedAt,
			endedAt: Date.now(),
			endReason: reason,
			...(error && { error }),
			asks,
		};
		const logPath = join(SESSIONS_DIR, `${session.id}.jsonl`);
		appendFileSync(logPath, JSON.stringify(log) + "\n");
		console.log(`Session logged to: ${logPath}`);
		session.close();
	};

	const resetTimeout = () => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		timeoutHandle = setTimeout(() => endSession("timeout"), INACTIVITY_TIMEOUT_MS);
	};

	resetTimeout();

	const wrapped = {
		id: session.id,
		repo: session.repo,

		async ask(question: string, options?: AskOptions): Promise<AskResult> {
			resetTimeout();
			const result = await session.ask(question, options);

			const isFirstAsk = asks.length === 0;
			asks.push({
				timestamp: Date.now(),
				question,
				toolCalls: result.toolCalls,
				response: result.response,
				usage: result.usage,
				inferenceTimeMs: result.inferenceTimeMs,
			});

			persistMessages();

			// Auto-set session title from first question
			if (isFirstAsk && dbSessionId) {
				const title = question.length > 80 ? `${question.slice(0, 77)}...` : question;
				updateSessionTitle(dbSessionId, title);
			}

			if (result.response.startsWith("[ERROR:")) {
				endSession("error", result.response);
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
			endSession("closed");
		},

		/** Set feedback on the most recent ask, or a specific ask by index */
		setFeedback(feedback: "like" | "dislike" | undefined, askIndex?: number) {
			const idx = askIndex ?? asks.length - 1;
			const entry = asks[idx];
			if (entry) {
				entry.feedback = feedback;
			}
		},
	};

	return wrapped;
}
