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

interface AuthState {
	authenticated: boolean;
	username: string | null;
	avatarUrl: string | null;
	loading: boolean;
	error?: string | null;
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
	const [buildTime, setBuildTime] = useState<string | null>(null);
	const [auth, setAuth] = useState<AuthState>({
		authenticated: false,
		username: null,
		avatarUrl: null,
		loading: true,
	});

	const [votes, setVotes] = useState<Record<string, "like" | "dislike">>({});
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const handleCopyMessage = useCallback((msgId: string, blocks: ContentBlock[]) => {
		const text = blocks
			.filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
			.map((b) => b.content)
			.join("\n\n");
		navigator.clipboard.writeText(text).then(() => {
			setCopiedId(msgId);
			setTimeout(() => setCopiedId((prev) => (prev === msgId ? null : prev)), 1500);
		});
	}, []);

	const handleVote = useCallback(
		(msgId: string, vote: "like" | "dislike") => {
			let newVote: "like" | "dislike" | undefined;
			setVotes((prev) => {
				newVote = prev[msgId] === vote ? undefined : vote;
				return { ...prev, [msgId]: newVote as never };
			});

			// Send feedback to server — derive ask index from assistant message order
			const askIndex = messages.filter((m) => m.role === "assistant").findIndex((m) => m.id === msgId);
			if (askIndex >= 0 && wsRef.current?.readyState === WebSocket.OPEN && connection.sessionId) {
				wsRef.current.send(
					JSON.stringify({ type: "feedback", sessionId: connection.sessionId, askIndex, feedback: newVote ?? null }),
				);
			}
		},
		[messages, connection.sessionId],
	);

	const urlInputRef = useRef<HTMLInputElement>(null);
	const askTextareaRef = useRef<HTMLTextAreaElement>(null);
	const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const shouldAutoScrollRef = useRef(true);
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

	// Check auth status on mount and handle OAuth errors
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const authError = params.get("error");
		if (authError) {
			window.history.replaceState({}, "", window.location.pathname);
			const errorMessages: Record<string, string> = {
				oauth_denied: "GitHub authorization was denied",
				invalid_callback: "Invalid OAuth callback",
				invalid_state: "Invalid OAuth state - please try again",
				token_exchange_failed: "Failed to exchange OAuth token",
				user_fetch_failed: "Failed to fetch user info from GitHub",
				user_not_found: "User not found",
				auth_failed: "Authentication failed - please try again",
			};
			setAuth({
				authenticated: false,
				username: null,
				avatarUrl: null,
				loading: false,
				error: errorMessages[authError] || "Authentication failed",
			});
			return;
		}

		fetch("/api/auth/status")
			.then((res) => res.json())
			.then((data) => {
				setAuth({
					authenticated: data.authenticated,
					username: data.username || null,
					avatarUrl: data.avatarUrl || null,
					loading: false,
					error: null,
				});
			})
			.catch(() => {
				setAuth({ authenticated: false, username: null, avatarUrl: null, loading: false, error: null });
			});
	}, []);

	// Load URL from localStorage on mount
	useEffect(() => {
		const savedUrl = localStorage.getItem("askforge_repo_url");
		if (savedUrl) {
			setUrl(savedUrl);
		}
	}, []);

	// Fetch build info on mount
	useEffect(() => {
		fetch("/build-info.json")
			.then((res) => res.json())
			.then((data) => setBuildTime(data.buildTime))
			.catch(() => {}); // Ignore errors (file may not exist in dev)
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

	// Check if user is near the bottom of the messages container
	const handleMessagesScroll = useCallback(() => {
		const container = messagesContainerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		// Consider "near bottom" if within 100px of the bottom
		shouldAutoScrollRef.current = distanceFromBottom < 100;
	}, []);

	// Auto-scroll to bottom when messages change (only if user hasn't scrolled up)
	useEffect(() => {
		if (shouldAutoScrollRef.current) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}
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

	const handleLogin = useCallback(() => {
		window.location.href = "/api/auth/github";
	}, []);

	const handleLogout = useCallback(async () => {
		await fetch("/api/auth/logout", { method: "POST" });
		setAuth({ authenticated: false, username: null, avatarUrl: null, loading: false });
	}, []);

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
		const charsToRelease =
			bufferLen > 100 ? Math.min(bufferLen, CHARS_PER_TICK * 5) : bufferLen > 50 ? CHARS_PER_TICK * 2 : CHARS_PER_TICK;

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
							const blocksToUse = streamingBlocksRef.current.length > 0 ? streamingBlocksRef.current : finalBlocks;
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
		// Show loading while checking auth
		if (auth.loading) {
			return (
				<div className="app-container phase-connect">
					<div className="connect-content">
						<h1 className="logo">
							<span className="logo-ask">ask</span>
							<span className="logo-forge">forge</span>
						</h1>
						<div className="auth-loading">
							<span className="spinner" />
						</div>
					</div>
				</div>
			);
		}

		// Show login if not authenticated
		if (!auth.authenticated) {
			return (
				<div className="app-container phase-connect">
					<div className="connect-content">
						<h1 className="logo">
							<span className="logo-ask">ask</span>
							<span className="logo-forge">forge</span>
						</h1>
						{auth.error && <div className="error-message">{auth.error}</div>}
						<button type="button" className="login-button" onClick={handleLogin}>
							<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							Sign in with GitHub
						</button>
						<p className="hint">Sign in to start exploring repositories</p>
					</div>
				</div>
			);
		}

		return (
			<div className="app-container phase-connect">
				<div className="connect-content">
					<div className="user-header">
						{auth.avatarUrl && <img src={auth.avatarUrl} alt="" className="user-avatar" />}
						<span className="user-name">{auth.username}</span>
						<button type="button" className="logout-link" onClick={handleLogout}>
							Sign out
						</button>
					</div>

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
				{buildTime && (
					<div className="deploy-info">
						{new Date(buildTime).toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}
					</div>
				)}
			</div>
		);
	}

	// Ask phase - show repo status and question input
	if (phase === "ask") {
		return (
			<div className="app-container phase-ask">
				<div className="ask-content">
					<div className="user-header">
						{auth.avatarUrl && <img src={auth.avatarUrl} alt="" className="user-avatar" />}
						<span className="user-name">{auth.username}</span>
						<button type="button" className="logout-link" onClick={handleLogout}>
							Sign out
						</button>
					</div>

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
				<div className="header-right">
					<div className="repo-status-inline">
						<span className="status-indicator connected" />
						<span className="repo-name">{connection.repoName}</span>
						{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
					</div>
					<div className="user-menu">
						{auth.avatarUrl && <img src={auth.avatarUrl} alt="" className="user-avatar-small" />}
						<button type="button" className="logout-link" onClick={handleLogout}>
							Sign out
						</button>
					</div>
				</div>
			</header>

			<main className="chat-main">
				<div className="messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
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
										{Object.keys(block.arguments).length > 0 && <pre>{JSON.stringify(block.arguments, null, 2)}</pre>}
									</details>
								),
							)}
							{msg.role === "assistant" && !isAsking && (
								<div className="message-actions">
									<button
										type="button"
										title={copiedId === msg.id ? "Copied!" : "Copy"}
										onClick={() => handleCopyMessage(msg.id, msg.contentBlocks)}
									>
										{copiedId === msg.id ? (
											<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
												<path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
											</svg>
										) : (
											<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
												<path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
											</svg>
										)}
									</button>
									<button
										type="button"
										title="Thumbs up"
										className={votes[msg.id] === "like" ? "active" : ""}
										onClick={() => handleVote(msg.id, "like")}
									>
										<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75a.75.75 0 0 1 .75-.75 2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 0 1-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 0 0-1.423-.23H3.75" />
										</svg>
									</button>
									<button
										type="button"
										title="Thumbs down"
										className={votes[msg.id] === "dislike" ? "active" : ""}
										onClick={() => handleVote(msg.id, "dislike")}
									>
										<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" d="M17.367 13.75c-.806 0-1.533.446-2.031 1.08a9.041 9.041 0 0 1-2.861 2.4c-.723.384-1.35.956-1.653 1.715a4.498 4.498 0 0 0-.322 1.672v.633a.75.75 0 0 1-.75.75 2.25 2.25 0 0 1-2.25-2.25c0-1.152.26-2.243.723-3.218.266-.558-.107-1.282-.725-1.282m0 0H4.372c-1.026 0-1.945-.694-2.054-1.715A12.134 12.134 0 0 1 2.25 12c0-2.848.992-5.464 2.649-7.521C5.287 3.997 5.886 3.75 6.504 3.75h4.016c.483 0 .964.078 1.423.23l3.114 1.04a4.501 4.501 0 0 0 1.423.23h2.27" />
										</svg>
									</button>
								</div>
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
