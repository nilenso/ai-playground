import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AskOptions, AskResult, Session, ToolCallRecord } from "ask-forge";

const SESSIONS_DIR = process.env.SESSION_DIR || "workdir/sessions";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface AskEntry {
	timestamp: number;
	question: string;
	toolCalls: ToolCallRecord[];
	response: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	inferenceTimeMs: number;
}

export function wrapSession(session: Session): Session {
	const startedAt = Date.now();
	const asks: AskEntry[] = [];
	let timeoutHandle: Timer | null = null;
	let terminated = false;

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

	return {
		id: session.id,
		repo: session.repo,

		async ask(question: string, options?: AskOptions): Promise<AskResult> {
			resetTimeout();
			const result = await session.ask(question, options);

			asks.push({
				timestamp: Date.now(),
				question,
				toolCalls: result.toolCalls,
				response: result.response,
				usage: result.usage,
				inferenceTimeMs: result.inferenceTimeMs,
			});

			if (result.response.startsWith("[ERROR:")) {
				endSession("error", result.response);
			}

			return result;
		},

		close() {
			endSession("closed");
		},
	};
}
