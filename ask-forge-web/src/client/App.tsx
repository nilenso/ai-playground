import { useState, useRef, useEffect, useCallback } from "react";
import { marked } from "marked";

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
}

interface ProgressState {
	type: "idle" | "thinking" | "tool" | "responding";
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

export function App() {
	const [url, setUrl] = useState("");
	const [connection, setConnection] = useState<ConnectionState>({
		status: "disconnected",
		sessionId: null,
		commitish: null,
		error: null,
	});
	const [messages, setMessages] = useState<Message[]>([]);
	const [inputValue, setInputValue] = useState("");
	const [isAsking, setIsAsking] = useState(false);
	const [progress, setProgress] = useState<ProgressState>({ type: "idle" });
	
	const urlInputRef = useRef<HTMLInputElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// Load URL from localStorage and auto-focus on mount
	useEffect(() => {
		const savedUrl = localStorage.getItem("askforge_repo_url");
		if (savedUrl) {
			setUrl(savedUrl);
		} else {
			urlInputRef.current?.focus();
		}
	}, []);

	// Auto-focus URL input when disconnected and empty
	useEffect(() => {
		if (connection.status === "disconnected" && !url) {
			urlInputRef.current?.focus();
		}
	}, [connection.status, url]);

	// Auto-scroll to bottom when messages change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// Focus question input when connected
	useEffect(() => {
		if (connection.status === "connected") {
			inputRef.current?.focus();
		}
	}, [connection.status]);

	const handleConnect = useCallback(async () => {
		if (!url.trim()) return;

		setConnection({ status: "connecting", sessionId: null, commitish: null, error: null });

		try {
			const res = await fetch("/api/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: url.trim() }),
			});

			const data = await res.json();

			if (!data.success) {
				setConnection({
					status: "error",
					sessionId: null,
					commitish: null,
					error: data.error || "Failed to connect",
				});
				return;
			}

			setConnection({
				status: "connected",
				sessionId: data.sessionId,
				commitish: data.commitish,
				error: null,
			});
			
			// Save URL to localStorage
			localStorage.setItem("askforge_repo_url", url.trim());
			
			// Clear previous messages on new connection
			setMessages([]);
		} catch (err) {
			setConnection({
				status: "error",
				sessionId: null,
				commitish: null,
				error: err instanceof Error ? err.message : "Network error",
			});
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
		setConnection({ status: "disconnected", sessionId: null, commitish: null, error: null });
		setMessages([]);
	}, [connection.sessionId]);

	const handleSend = useCallback(async () => {
		if (!inputValue.trim() || !connection.sessionId || isAsking) return;

		const question = inputValue.trim();
		setInputValue("");
		setIsAsking(true);
		setProgress({ type: "thinking" });

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
			inputRef.current?.focus();
		}
	}, [inputValue, connection.sessionId, isAsking]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleUrlKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleConnect();
		}
	};

	return (
		<div style={styles.container}>
			{/* Top Bar */}
			<header style={styles.topBar}>
				<input
					ref={urlInputRef}
					type="text"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={handleUrlKeyDown}
					placeholder="https://github.com/owner/repo"
					style={styles.repoInput}
					disabled={connection.status === "connecting"}
				/>
				{connection.commitish && (
					<code style={styles.commitBadge}>{connection.commitish.slice(0, 7)}</code>
				)}
				{connection.status === "connected" ? (
					<button style={styles.button} onClick={handleDisconnect}>Disconnect</button>
				) : (
					<button
						style={styles.button}
						onClick={handleConnect}
						disabled={connection.status === "connecting" || !url.trim()}
					>
						{connection.status === "connecting" ? "..." : "Connect"}
					</button>
				)}
				{connection.error && <span style={styles.error}>{connection.error}</span>}
			</header>

			{/* Conversation Area */}
			<main style={styles.main}>
				{connection.status === "connected" && (
					<div style={styles.messages}>
						{messages.map((msg) => (
							<div key={msg.id} style={styles.message}>
								<div style={styles.role}>{msg.role === "user" ? "You" : "Assistant"}</div>
								<div 
									className="markdown-content"
									dangerouslySetInnerHTML={{ __html: marked(msg.content) as string }}
								/>
								{msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0 && (
									<details style={styles.toolCalls}>
										<summary>{msg.toolCalls.length} tool call{msg.toolCalls.length > 1 ? "s" : ""}</summary>
										{msg.toolCalls.map((tc, i) => (
											<div key={i} style={styles.toolCall}>
												<code>{tc.name}</code> {JSON.stringify(tc.arguments)}
											</div>
										))}
									</details>
								)}
							</div>
						))}
						{isAsking && (
							<div style={styles.message}>
								<div style={styles.role}>Assistant</div>
								<div style={styles.status}>
									{progress.type === "thinking" && "Thinking..."}
									{progress.type === "tool" && `Running ${progress.toolName}: ${JSON.stringify(progress.toolArgs)}`}
									{progress.type === "responding" && "Writing response..."}
								</div>
							</div>
						)}
						<div ref={messagesEndRef} />
					</div>
				)}

				{/* Input Area */}
				{connection.status === "connected" && (
					<div style={styles.inputArea}>
						<textarea
							ref={inputRef}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask a question..."
							style={styles.textarea}
							rows={2}
							disabled={isAsking}
						/>
						<button style={styles.button} onClick={handleSend} disabled={isAsking || !inputValue.trim()}>
							{isAsking ? "..." : "Send"}
						</button>
					</div>
				)}
			</main>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		height: "100vh",
		display: "flex",
		flexDirection: "column",
		fontFamily: "system-ui, sans-serif",
		fontSize: "14px",
	},
	topBar: {
		display: "flex",
		gap: "8px",
		padding: "12px",
		borderBottom: "1px solid #ddd",
		alignItems: "center",
	},
	repoInput: {
		flex: 1,
		padding: "8px",
		border: "1px solid #ddd",
		borderRadius: "4px",
		fontFamily: "monospace",
		fontSize: "13px",
	},
	commitBadge: {
		padding: "4px 8px",
		backgroundColor: "#eee",
		borderRadius: "4px",
		fontSize: "12px",
	},
	button: {
		padding: "8px 16px",
		border: "1px solid #ddd",
		borderRadius: "4px",
		background: "white",
		cursor: "pointer",
	},
	error: {
		color: "#c00",
		fontSize: "13px",
	},
	main: {
		flex: 1,
		display: "flex",
		flexDirection: "column",
		overflow: "hidden",
	},
	messages: {
		flex: 1,
		overflowY: "auto",
		padding: "16px",
		display: "flex",
		flexDirection: "column",
		gap: "16px",
	},
	message: {
		padding: "12px",
		borderRadius: "4px",
		backgroundColor: "#f9f9f9",
		border: "1px solid #eee",
	},
	role: {
		fontWeight: 600,
		marginBottom: "8px",
		fontSize: "12px",
		textTransform: "uppercase",
		color: "#666",
	},
	status: {
		color: "#666",
		fontStyle: "italic",
	},
	toolCalls: {
		marginTop: "8px",
		fontSize: "12px",
		color: "#666",
	},
	toolCall: {
		fontFamily: "monospace",
		fontSize: "11px",
		color: "#888",
		marginTop: "4px",
	},
	inputArea: {
		display: "flex",
		gap: "8px",
		padding: "12px",
		borderTop: "1px solid #ddd",
	},
	textarea: {
		flex: 1,
		padding: "8px",
		border: "1px solid #ddd",
		borderRadius: "4px",
		fontFamily: "inherit",
		fontSize: "14px",
		resize: "none",
	},
};
