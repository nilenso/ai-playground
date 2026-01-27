import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMarkedWithFileLinks } from "./file-linker.ts";

// Content blocks represent ordered segments of text and tool calls
type ContentBlock =
	| { type: "text"; content: string }
	| { type: "tool_call"; name: string; arguments: Record<string, unknown>; isComplete: boolean };

interface Message {
	id: string;
	role: "user" | "assistant";
	contentBlocks: ContentBlock[];
	thinking?: string;
	isStreaming?: boolean;
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
	thinkingContent?: string;
	textContent?: string;
}

type AppPhase = "connect" | "ask" | "chat";

// Format tool calls in a CLI-like style for display
function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "ls":
			return `ls ${args.path || "."}`;
		case "Read":
		case "read":
			return `read ${args.file_path || args.path || ""}`;
		case "rg":
		case "Grep":
		case "grep": {
			let cmd = `rg "${args.pattern}"`;
			if (args.glob) cmd += ` --glob "${args.glob}"`;
			if (args.path) cmd += ` ${args.path}`;
			return cmd;
		}
		case "Glob":
		case "glob":
			return `glob "${args.pattern}"${args.path ? ` in ${args.path}` : ""}`;
		case "Bash":
		case "bash": {
			const cmdStr = String(args.command || "");
			return cmdStr.length > 60 ? `bash ${cmdStr.slice(0, 60)}...` : `bash ${cmdStr}`;
		}
		case "Write":
		case "write":
		case "Edit":
		case "edit":
			return `${name.toLowerCase()} ${args.file_path || ""}`;
		default: {
			// For unknown tools, show key=value pairs concisely
			const pairs = Object.entries(args)
				.slice(0, 3)
				.map(([k, v]) => {
					const val = typeof v === "string" ? v : JSON.stringify(v);
					const truncated = val.length > 30 ? val.slice(0, 30) + "..." : val;
					return `${k}="${truncated}"`;
				});
			return `${name} ${pairs.join(" ")}`;
		}
	}
}

function extractRepoName(url: string): string {
	// Extract repo name from URL like "https://github.com/owner/repo" -> "owner/repo"
	const match = url.match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+\/[^/.]+)/i);
	if (match?.[1]) return match[1];
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

	const urlInputRef = useRef<HTMLInputElement>(null);
	const askTextareaRef = useRef<HTMLTextAreaElement>(null);
	const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const currentRequestIdRef = useRef<string | null>(null);
	const reconnectAttemptRef = useRef(0);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingMessageRef = useRef<{ requestId: string; sessionId: string; question: string } | null>(null);

	// Create a marked instance that links file paths to the forge
	const markedWithLinks = useMemo(
		() => createMarkedWithFileLinks(url, connection.commitish),
		[url, connection.commitish],
	);

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
			urlInputRef.current?.focus();
		} else if (phase === "ask") {
			askTextareaRef.current?.focus();
		} else if (phase === "chat") {
			chatTextareaRef.current?.focus();
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

	// Generate unique request ID
	const generateRequestId = useCallback(() => {
		return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}, []);

	// Refs for accumulating streaming content
	const streamingMessageIdRef = useRef<string | null>(null);
	const streamingThinkingRef = useRef("");
	const streamingBlocksRef = useRef<ContentBlock[]>([]);

	// Text buffering for smooth character-by-character release
	const textBufferRef = useRef(""); // Pending text not yet displayed
	const releaseIntervalRef = useRef<number | null>(null);
	const CHARS_PER_TICK = 2; // Base chars to release per tick (~120 chars/sec at 60fps)
	const TICK_MS = 16; // ~60fps

	// Update the UI with current streaming state
	const updateStreamingUI = useCallback(() => {
		if (!streamingMessageIdRef.current) return;
		setMessages((prev) =>
			prev.map((msg) =>
				msg.id === streamingMessageIdRef.current
					? { ...msg, thinking: streamingThinkingRef.current, contentBlocks: [...streamingBlocksRef.current] }
					: msg,
			),
		);
	}, []);

	// Release characters from buffer to displayed text
	const releaseChars = useCallback(() => {
		if (textBufferRef.current.length === 0) return;

		// Adaptive rate: speed up if buffer is growing to avoid falling behind
		const bufferLen = textBufferRef.current.length;
		const charsToRelease = bufferLen > 100 ? Math.min(bufferLen, CHARS_PER_TICK * 5) : bufferLen > 50 ? CHARS_PER_TICK * 2 : CHARS_PER_TICK;

		// Move chars from buffer to the last text block
		const chars = textBufferRef.current.slice(0, charsToRelease);
		textBufferRef.current = textBufferRef.current.slice(charsToRelease);

		const blocks = streamingBlocksRef.current;
		const lastBlock = blocks[blocks.length - 1];
		if (lastBlock && lastBlock.type === "text") {
			lastBlock.content += chars;
		} else {
			blocks.push({ type: "text", content: chars });
		}

		updateStreamingUI();
	}, [updateStreamingUI]);

	// Start the release loop if not already running
	const startReleaseLoop = useCallback(() => {
		if (releaseIntervalRef.current !== null) return;
		releaseIntervalRef.current = window.setInterval(releaseChars, TICK_MS);
	}, [releaseChars]);

	// Stop the release loop
	const stopReleaseLoop = useCallback(() => {
		if (releaseIntervalRef.current !== null) {
			clearInterval(releaseIntervalRef.current);
			releaseIntervalRef.current = null;
		}
	}, []);

	// Flush all buffered text immediately (for tool calls, completion, etc.)
	const flushTextBuffer = useCallback(() => {
		if (textBufferRef.current.length === 0) return;

		const blocks = streamingBlocksRef.current;
		const lastBlock = blocks[blocks.length - 1];
		if (lastBlock && lastBlock.type === "text") {
			lastBlock.content += textBufferRef.current;
		} else {
			blocks.push({ type: "text", content: textBufferRef.current });
		}
		textBufferRef.current = "";
		updateStreamingUI();
	}, [updateStreamingUI]);

	// WebSocket message handler
	const handleWsMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const message = JSON.parse(event.data);

				// Ignore messages for other requests (out of order protection)
				if (message.requestId && message.requestId !== currentRequestIdRef.current) {
					return;
				}

				if (message.type === "pong") {
					// Heartbeat response - connection is alive
					return;
				}

				if (message.type === "progress") {
					const data = message.data;

					// Initialize streaming message if needed
					if (!streamingMessageIdRef.current) {
						streamingMessageIdRef.current = `assistant-${Date.now()}`;
						streamingThinkingRef.current = "";
						streamingBlocksRef.current = [];

						// Add streaming message placeholder
						setMessages((prev) => [
							...prev,
							{
								id: streamingMessageIdRef.current!,
								role: "assistant",
								contentBlocks: [],
								thinking: "",
								isStreaming: true,
							},
						]);
					}

					if (data.type === "thinking") {
						setProgress({ type: "thinking" });
					} else if (data.type === "thinking_delta") {
						// Update thinking immediately (no buffering)
						streamingThinkingRef.current += data.delta;
						setProgress((prev) => ({ ...prev, type: "thinking" }));
						updateStreamingUI();
					} else if (data.type === "text_delta") {
						// Buffer text for smooth release
						textBufferRef.current += data.delta;
						setProgress((prev) => ({ ...prev, type: "responding" }));
						startReleaseLoop();
					} else if (data.type === "tool_start") {
						// Flush any buffered text before showing tool
						flushTextBuffer();
						// Add a new incomplete tool call block
						streamingBlocksRef.current = [
							...streamingBlocksRef.current,
							{ type: "tool_call", name: data.name, arguments: data.arguments || {}, isComplete: false },
						];
						updateStreamingUI();
						setProgress({ type: "tool", toolName: data.name, toolArgs: data.arguments });
					} else if (data.type === "tool_end") {
						// Flush any buffered text
						flushTextBuffer();
						// Mark the matching incomplete tool call as complete
						const blocks = streamingBlocksRef.current;
						for (let i = blocks.length - 1; i >= 0; i--) {
							const block = blocks[i];
							if (block && block.type === "tool_call" && block.name === data.name && !block.isComplete) {
								blocks[i] = {
									...block,
									arguments: data.arguments || block.arguments,
									isComplete: true,
								};
								break;
							}
						}
						streamingBlocksRef.current = [...blocks];
						updateStreamingUI();
						setProgress({ type: "thinking" });
					} else if (data.type === "responding") {
						setProgress({ type: "responding" });
					}
				} else if (message.type === "done") {
					// Stop release loop and flush remaining buffer
					stopReleaseLoop();
					flushTextBuffer();

					const data = message.data;

					// Finalize the streaming message or create new one if no streaming happened
					if (data.success) {
						// Convert final data to content blocks if present
						const finalBlocks: ContentBlock[] = [];
						if (data.response) {
							finalBlocks.push({ type: "text", content: data.response });
						}
						if (data.toolCalls && Array.isArray(data.toolCalls)) {
							for (const tc of data.toolCalls) {
								finalBlocks.push({ type: "tool_call", name: tc.name, arguments: tc.arguments, isComplete: true });
							}
						}

						if (streamingMessageIdRef.current) {
							// Update streaming message with final content
							// Use streamed blocks if available, otherwise use final blocks
							const blocksToUse =
								streamingBlocksRef.current.length > 0 ? streamingBlocksRef.current : finalBlocks;
							setMessages((prev) =>
								prev.map((msg) =>
									msg.id === streamingMessageIdRef.current
										? {
												...msg,
												contentBlocks: blocksToUse,
												isStreaming: false,
											}
										: msg,
								),
							);
						} else {
							// No streaming happened, add message directly
							setMessages((prev) => [
								...prev,
								{
									id: `assistant-${Date.now()}`,
									role: "assistant",
									contentBlocks: finalBlocks,
								},
							]);
						}
					} else {
						// Error case - remove streaming message and add error
						if (streamingMessageIdRef.current) {
							setMessages((prev) => prev.filter((msg) => msg.id !== streamingMessageIdRef.current));
						}
						setMessages((prev) => [
							...prev,
							{
								id: `error-${Date.now()}`,
								role: "assistant",
								contentBlocks: [{ type: "text", content: `Error: ${data.error || "Failed to get response"}` }],
							},
						]);
					}

					// Reset streaming state
					streamingMessageIdRef.current = null;
					streamingThinkingRef.current = "";
					streamingBlocksRef.current = [];
					textBufferRef.current = "";

					currentRequestIdRef.current = null;
					pendingMessageRef.current = null;
					setIsAsking(false);
					setProgress({ type: "idle" });
					if (phase === "chat") {
						chatTextareaRef.current?.focus();
					}
				} else if (message.type === "error") {
					// Stop release loop
					stopReleaseLoop();

					// Remove streaming message if present
					if (streamingMessageIdRef.current) {
						setMessages((prev) => prev.filter((msg) => msg.id !== streamingMessageIdRef.current));
					}
					setMessages((prev) => [
						...prev,
						{
							id: `error-${Date.now()}`,
							role: "assistant",
							contentBlocks: [{ type: "text", content: `Error: ${message.error || "Failed to get response"}` }],
						},
					]);

					// Reset streaming state
					streamingMessageIdRef.current = null;
					streamingThinkingRef.current = "";
					streamingBlocksRef.current = [];
					textBufferRef.current = "";

					currentRequestIdRef.current = null;
					pendingMessageRef.current = null;
					setIsAsking(false);
					setProgress({ type: "idle" });
				} else if (message.type === "cancelled") {
					// Stop release loop
					stopReleaseLoop();

					// Remove streaming message if present
					if (streamingMessageIdRef.current) {
						setMessages((prev) => prev.filter((msg) => msg.id !== streamingMessageIdRef.current));
					}

					// Reset streaming state
					streamingMessageIdRef.current = null;
					streamingThinkingRef.current = "";
					streamingBlocksRef.current = [];
					textBufferRef.current = "";

					currentRequestIdRef.current = null;
					pendingMessageRef.current = null;
					setIsAsking(false);
					setProgress({ type: "idle" });
				}
			} catch {
				// Ignore JSON parse errors
			}
		},
		[phase, updateStreamingUI, startReleaseLoop, stopReleaseLoop, flushTextBuffer],
	);

	// Create/reconnect WebSocket with exponential backoff
	const connectWebSocket = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			return;
		}

		// Clear any pending reconnect
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[WS] Connected");
			reconnectAttemptRef.current = 0;

			// Resend pending message if any (reconnection recovery)
			if (pendingMessageRef.current) {
				ws.send(JSON.stringify({ type: "ask", ...pendingMessageRef.current }));
			}
		};

		ws.onmessage = handleWsMessage;

		ws.onerror = (error) => {
			console.error("[WS] Error:", error);
		};

		ws.onclose = (event) => {
			console.log(`[WS] Closed: ${event.code} ${event.reason}`);
			wsRef.current = null;

			// If we have a pending request, attempt reconnect with exponential backoff
			if (pendingMessageRef.current && reconnectAttemptRef.current < 5) {
				const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 30000);
				console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current + 1})`);
				reconnectAttemptRef.current++;
				reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
			} else if (pendingMessageRef.current) {
				// Max retries exceeded
				setMessages((prev) => [
					...prev,
					{
						id: `error-${Date.now()}`,
						role: "assistant",
						contentBlocks: [{ type: "text", content: "Error: Connection lost. Please try again." }],
					},
				]);
				currentRequestIdRef.current = null;
				pendingMessageRef.current = null;
				setIsAsking(false);
				setProgress({ type: "idle" });
			}
		};
	}, [handleWsMessage]);

	// Cleanup WebSocket and release loop on unmount
	useEffect(() => {
		return () => {
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (releaseIntervalRef.current !== null) {
				clearInterval(releaseIntervalRef.current);
			}
			if (wsRef.current) {
				wsRef.current.close();
			}
		};
	}, []);

	const handleSend = useCallback(() => {
		if (!inputValue.trim() || !connection.sessionId || isAsking) return;

		const question = inputValue.trim();
		const requestId = generateRequestId();

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
			contentBlocks: [{ type: "text", content: question }],
		};
		setMessages((prev) => [...prev, userMessage]);

		// Store request info for correlation and reconnection recovery
		currentRequestIdRef.current = requestId;
		pendingMessageRef.current = { requestId, sessionId: connection.sessionId, question };

		// Ensure WebSocket is connected and send
		connectWebSocket();

		// Send message if already connected
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "ask", ...pendingMessageRef.current }));
		}
		// Otherwise, onopen handler will send it
	}, [inputValue, connection.sessionId, isAsking, phase, generateRequestId, connectWebSocket]);

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
							ref={urlInputRef}
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
								ref={askTextareaRef}
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
						<div key={msg.id} className={`message message-${msg.role}${msg.isStreaming ? " streaming" : ""}`}>
							<div className="message-role">
								{msg.role === "user" ? "You" : "Assistant"}
								{msg.isStreaming && <span className="streaming-indicator" />}
							</div>
							{msg.thinking && (
								<details className="thinking-block" open={msg.isStreaming}>
									<summary>Thinking...</summary>
									<div className="thinking-content">{msg.thinking}</div>
								</details>
							)}
							{msg.contentBlocks.map((block, idx) =>
								block.type === "text" ? (
									<div
										key={`${msg.id}-text-${idx}`}
										className="markdown-content"
										dangerouslySetInnerHTML={{ __html: markedWithLinks.parse(block.content) as string }}
									/>
								) : (
									<details
										key={`${msg.id}-tool-${idx}`}
										className="tool-call-inline"
										open={msg.isStreaming && !block.isComplete}
									>
										<summary>
											<code>{formatToolCall(block.name, block.arguments)}</code>
											{!block.isComplete && <span className="spinner small" />}
										</summary>
										{Object.keys(block.arguments).length > 0 && (
											<pre>{JSON.stringify(block.arguments, null, 2)}</pre>
										)}
									</details>
								),
							)}
						</div>
					))}
					{/* Show status indicator only when asking but no streaming message yet */}
					{isAsking && !messages.some((m) => m.isStreaming) && (
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
						ref={chatTextareaRef}
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
