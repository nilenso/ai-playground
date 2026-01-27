import { marked } from "marked";
import { useCallback, useEffect, useRef, useState } from "react";

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

interface ConnectionState {
	status: "disconnected" | "connecting" | "connected" | "error";
	sessionId: string | null;
	commitish: string | null;
	error: string | null;
	repoName: string | null;
}

interface ProgressState {
	type: "idle" | "thinking" | "tool" | "responding";
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

type AppPhase = "connect" | "ask" | "chat";

function extractRepoName(url: string): string {
	// Extract repo name from URL like "https://github.com/owner/repo" -> "owner/repo"
	const match = url.match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+\/[^/.]+)/i);
	if (match && match[1]) return match[1];
	// Fallback: just get last two path segments
	const parts = url
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (parts.length >= 2) {
		const owner = parts[parts.length - 2];
		const repo = parts[parts.length - 1];
		if (owner && repo) return `${owner}/${repo}`;
	}
	return url;
}

export function App() {
	const [url, setUrl] = useState("");
	const [connection, setConnection] = useState<ConnectionState>({
		status: "disconnected",
		sessionId: null,
		commitish: null,
		error: null,
		repoName: null,
	});
	const [messages, setMessages] = useState<Message[]>([]);
	const [inputValue, setInputValue] = useState("");
	const [isAsking, setIsAsking] = useState(false);
	const [progress, setProgress] = useState<ProgressState>({ type: "idle" });
	const [phase, setPhase] = useState<AppPhase>("connect");

	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// Load URL from localStorage on mount
	useEffect(() => {
		const savedUrl = localStorage.getItem("askforge_repo_url");
		if (savedUrl) {
			setUrl(savedUrl);
		}
	}, []);

	// Auto-focus input based on phase
	useEffect(() => {
		if (phase === "connect") {
			inputRef.current?.focus();
		} else if (phase === "ask") {
			inputRef.current?.focus();
		} else if (phase === "chat") {
			textareaRef.current?.focus();
		}
	}, [phase]);

	// Auto-scroll to bottom when messages change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	const handleConnect = useCallback(async () => {
		if (!url.trim()) return;

		setConnection((prev) => ({ ...prev, status: "connecting", error: null }));

		try {
			const res = await fetch("/api/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: url.trim() }),
			});

			const data = await res.json();

			if (!data.success) {
				setConnection((prev) => ({
					...prev,
					status: "error",
					error: data.error || "Failed to connect",
				}));
				return;
			}

			const repoName = extractRepoName(url.trim());
			setConnection({
				status: "connected",
				sessionId: data.sessionId,
				commitish: data.commitish,
				error: null,
				repoName,
			});

			// Save URL to localStorage
			localStorage.setItem("askforge_repo_url", url.trim());

			// Transition to ask phase
			setPhase("ask");
			setMessages([]);
		} catch (err) {
			setConnection((prev) => ({
				...prev,
				status: "error",
				error: err instanceof Error ? err.message : "Network error",
			}));
		}
	}, [url]);

	const handleDisconnect = useCallback(async () => {
		if (connection.sessionId) {
			try {
				await fetch("/api/disconnect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: connection.sessionId }),
				});
			} catch {
				// Ignore disconnect errors
			}
		}
		setConnection({
			status: "disconnected",
			sessionId: null,
			commitish: null,
			error: null,
			repoName: null,
		});
		setMessages([]);
		setPhase("connect");
	}, [connection.sessionId]);

	const handleSend = useCallback(async () => {
		if (!inputValue.trim() || !connection.sessionId || isAsking) return;

		const question = inputValue.trim();
		setInputValue("");
		setIsAsking(true);
		setProgress({ type: "thinking" });

		// Transition to chat phase on first message
		if (phase === "ask") {
			setPhase("chat");
		}

		// Add user message immediately
		const userMessage: Message = {
			id: `user-${Date.now()}`,
			role: "user",
			content: question,
		};
		setMessages((prev) => [...prev, userMessage]);

		try {
			const res = await fetch("/api/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: connection.sessionId,
					question,
				}),
			});

			const reader = res.body?.getReader();
			const decoder = new TextDecoder();

			if (!reader) {
				throw new Error("No response body");
			}

			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				let eventType = "";
				for (const line of lines) {
					if (line.startsWith("event: ")) {
						eventType = line.slice(7);
					} else if (line.startsWith("data: ") && eventType) {
						const data = JSON.parse(line.slice(6));

						if (eventType === "progress") {
							if (data.type === "thinking") {
								setProgress({ type: "thinking" });
							} else if (data.type === "tool_start") {
								setProgress({ type: "tool", toolName: data.name, toolArgs: data.arguments });
							} else if (data.type === "tool_end") {
								setProgress({ type: "thinking" });
							} else if (data.type === "responding") {
								setProgress({ type: "responding" });
							}
						} else if (eventType === "done") {
							if (data.success) {
								const assistantMessage: Message = {
									id: `assistant-${Date.now()}`,
									role: "assistant",
									content: data.response,
									toolCalls: data.toolCalls,
								};
								setMessages((prev) => [...prev, assistantMessage]);
							} else {
								setMessages((prev) => [
									...prev,
									{
										id: `error-${Date.now()}`,
										role: "assistant",
										content: `Error: ${data.error || "Failed to get response"}`,
									},
								]);
							}
						} else if (eventType === "error") {
							setMessages((prev) => [
								...prev,
								{
									id: `error-${Date.now()}`,
									role: "assistant",
									content: `Error: ${data.error || "Failed to get response"}`,
								},
							]);
						}
						eventType = "";
					}
				}
			}
		} catch (err) {
			setMessages((prev) => [
				...prev,
				{
					id: `error-${Date.now()}`,
					role: "assistant",
					content: `Error: ${err instanceof Error ? err.message : "Network error"}`,
				},
			]);
		} finally {
			setIsAsking(false);
			setProgress({ type: "idle" });
			if (phase === "chat") {
				textareaRef.current?.focus();
			}
		}
	}, [inputValue, connection.sessionId, isAsking, phase]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (phase === "connect") {
				handleConnect();
			} else {
				handleSend();
			}
		}
	};

	// Connect phase - centered input for repo URL
	if (phase === "connect") {
		return (
			<div className="app-container phase-connect">
				<div className="connect-content">
					<h1 className="logo">
						<span className="logo-ask">ask</span>
						<span className="logo-forge">forge</span>
					</h1>

					<div className="input-container">
						<input
							ref={inputRef}
							type="text"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Enter repository URL..."
							className="main-input"
							disabled={connection.status === "connecting"}
						/>
						<button
							type="button"
							className="connect-button"
							onClick={handleConnect}
							disabled={connection.status === "connecting" || !url.trim()}
						>
							{connection.status === "connecting" ? <span className="spinner" /> : "Connect"}
						</button>
					</div>

					{connection.error && <div className="error-message">{connection.error}</div>}

					<p className="hint">Paste a GitHub, GitLab, or Bitbucket URL</p>
				</div>
			</div>
		);
	}

	// Ask phase - show repo status and question input
	if (phase === "ask") {
		return (
			<div className="app-container phase-ask">
				<div className="ask-content">
					<h1 className="logo">
						<span className="logo-ask">ask</span>
						<span className="logo-forge">forge</span>
					</h1>

					<div className="input-container">
						<div className="input-wrapper">
							<textarea
								ref={inputRef}
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder='Ask anything... "Explain the architecture"'
								className="main-input"
								disabled={isAsking}
								rows={3}
							/>
						</div>
					</div>

					<div className="repo-status">
						<span className="status-indicator connected" />
						<span className="repo-name">{connection.repoName}</span>
						{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
						<button type="button" className="disconnect-link" onClick={handleDisconnect}>
							Disconnect
						</button>
					</div>
				</div>
			</div>
		);
	}

	// Chat phase - full conversation view
	return (
		<div className="app-container phase-chat">
			<header className="chat-header">
				<div className="header-left">
					<h1 className="logo-small">
						<span className="logo-ask">ask</span>
						<span className="logo-forge">forge</span>
					</h1>
					<button
						type="button"
						className="new-question-button"
						onClick={handleDisconnect}
						aria-label="Start new question"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
							<path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
						</svg>
						New
					</button>
				</div>
				<div className="repo-status-inline">
					<span className="status-indicator connected" />
					<span className="repo-name">{connection.repoName}</span>
					{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
				</div>
			</header>

			<main className="chat-main">
				<div className="messages">
					{messages.map((msg) => (
						<div key={msg.id} className={`message message-${msg.role}`}>
							<div className="message-role">{msg.role === "user" ? "You" : "Assistant"}</div>
							<div className="markdown-content" dangerouslySetInnerHTML={{ __html: marked(msg.content) as string }} />
							{msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0 && (
								<details className="tool-calls">
									<summary>
										{msg.toolCalls.length} tool call{msg.toolCalls.length > 1 ? "s" : ""}
									</summary>
									{msg.toolCalls.map((tc) => (
										<div key={`${msg.id}-${tc.name}`} className="tool-call">
											<code>{tc.name}</code> {JSON.stringify(tc.arguments)}
										</div>
									))}
								</details>
							)}
						</div>
					))}
					{isAsking && (
						<div className="message message-assistant">
							<div className="message-role">Assistant</div>
							<div className="thinking-status">
								{progress.type === "thinking" && (
									<>
										<span className="thinking-dots">
											<span>.</span>
											<span>.</span>
											<span>.</span>
										</span>
										Thinking
									</>
								)}
								{progress.type === "tool" && (
									<>
										<span className="tool-icon">&#8594;</span>
										{progress.toolName}
									</>
								)}
								{progress.type === "responding" && "Writing response..."}
							</div>
						</div>
					)}
					<div ref={messagesEndRef} />
				</div>
			</main>

			<footer className="chat-footer">
				<div className="chat-input-container">
					<textarea
						ref={textareaRef}
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Ask a follow-up question..."
						className="chat-textarea"
						rows={1}
						disabled={isAsking}
					/>
					<button type="button" className="send-button" onClick={handleSend} disabled={isAsking || !inputValue.trim()}>
						{isAsking ? <span className="spinner small" /> : "Send"}
					</button>
				</div>
			</footer>
		</div>
	);
}
