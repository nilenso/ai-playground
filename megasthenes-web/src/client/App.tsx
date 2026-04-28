import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskPhase } from "./components/AskPhase.tsx";
import { ChatPhase } from "./components/ChatPhase.tsx";
import { ConnectPhase } from "./components/ConnectPhase.tsx";
import { SharedView } from "./components/SharedView.tsx";
import type { Sidebar } from "./components/Sidebar.tsx";
import { createMarkedWithFileLinks } from "./file-linker.ts";
import { useAuth } from "./hooks/useAuth.ts";
import { useSession } from "./hooks/useSession.ts";
import { useStreaming } from "./hooks/useStreaming.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import type { AppPhase, ConnectionState, ContentBlock, Message, ProgressState } from "./types.ts";
import { extractRepoName } from "./utils.ts";

// Check if we're on a /share/:token route
function getShareToken(): string | null {
	const match = window.location.pathname.match(/^\/share\/([a-f0-9]+)$/);
	return match?.[1] ?? null;
}

// Check if we're on a /c/:sessionId route (session permalink)
function getSessionIdFromUrl(): string | null {
	const match = window.location.pathname.match(/^\/c\/([a-f0-9-]+)$/);
	return match?.[1] ?? null;
}

export function App() {
	// Handle /share/:token route
	const shareToken = getShareToken();
	if (shareToken) {
		return <SharedView token={shareToken} />;
	}

	const [url, setUrl] = useState("");
	const [connection, setConnection] = useState<ConnectionState>({
		status: "disconnected",
		sessionId: null,
		commitish: null,
		error: null,
		repoName: null,
		progressMessage: null,
	});
	const [messages, setMessages] = useState<Message[]>([]);
	const [inputValue, setInputValue] = useState("");
	const [isAsking, setIsAsking] = useState(false);
	const [progress, setProgress] = useState<ProgressState>({ type: "idle" });
	const [phase, setPhase] = useState<AppPhase>("connect");
	const [buildTime, setBuildTime] = useState<string | null>(null);

	const [votes, setVotes] = useState<Record<string, "like" | "dislike">>({});
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");

	const urlInputRef = useRef<HTMLInputElement>(null);
	const askTextareaRef = useRef<HTMLTextAreaElement>(null);
	const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const shouldAutoScrollRef = useRef(true);
	const [isAutoScrolling, setIsAutoScrolling] = useState(true);
	const lastScrollTopRef = useRef(0);
	const lastAutoScrollTimeRef = useRef(0);
	const autoScrollThrottleMs = 150;
	const isProgrammaticScrollRef = useRef(false);
	const phaseRef = useRef(phase);
	phaseRef.current = phase;

	// --- Hooks ---

	const onLogout = useCallback(() => {
		setMessages([]);
		setInputValue("");
		setIsAsking(false);
		setProgress({ type: "idle" });
		setConnection({
			status: "disconnected",
			sessionId: null,
			commitish: null,
			error: null,
			repoName: null,
			progressMessage: null,
		});
		setPhase("connect");
	}, []);

	const { auth, handleLogin, handleLogout, refreshAuth } = useAuth({
		connectionSessionId: connection.sessionId,
		onLogout,
	});

	const streaming = useStreaming(setMessages);

	const {
		wsRef,
		currentRequestIdRef,
		requestToSessionRef,
		sessionRequestRef,
		pendingMessageRef,
		connectWebSocket,
		generateRequestId,
		resumeStreaming,
	} = useWebSocket({
		streaming,
		setMessages,
		setIsAsking,
		setProgress,
		phaseRef,
		chatTextareaRef,
	});

	const session = useSession({
		authenticated: auth.authenticated,
		setConnection,
		setMessages,
		setPhase,
		setUrl,
		setIsAsking,
		setProgress,
		currentRequestIdRef,
		pendingMessageRef,
		requestToSessionRef,
		sessionRequestRef,
		streamingMessageIdRef: streaming.streamingMessageIdRef,
		streamingThinkingRef: streaming.streamingThinkingRef,
		streamingBlocksRef: streaming.streamingBlocksRef,
		textBufferRef: streaming.textBufferRef,
		releaseIntervalRef: streaming.releaseIntervalRef,
		connectionSessionId: connection.sessionId,
		resumeStreaming,
	});

	// --- Memos ---

	const markedWithLinks = useMemo(
		() => createMarkedWithFileLinks(url, connection.commitish),
		[url, connection.commitish],
	);

	// --- Callbacks ---

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

			const askIndex = messages.filter((m) => m.role === "assistant").findIndex((m) => m.id === msgId);
			if (askIndex >= 0 && wsRef.current?.readyState === WebSocket.OPEN && connection.sessionId) {
				wsRef.current.send(
					JSON.stringify({ type: "feedback", sessionId: connection.sessionId, askIndex, feedback: newVote ?? null }),
				);
			}
		},
		[messages, connection.sessionId, wsRef],
	);

	const connectToRepo = useCallback(
		async (repoUrl: string) => {
			setConnection((prev) => ({ ...prev, status: "connecting", error: null, progressMessage: null }));

			try {
				const res = await fetch("/api/connect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ url: repoUrl }),
				});

				if (!res.ok || !res.body) {
					const text = await res.text();
					let errorMsg = "Failed to connect";
					try {
						errorMsg = JSON.parse(text).error || errorMsg;
					} catch {
						/* non-JSON error response */
					}
					setConnection((prev) => ({ ...prev, status: "error", error: errorMsg, progressMessage: null }));
					return;
				}

				// Read SSE stream
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });

					// Parse SSE events from buffer
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

					let currentEvent = "";
					for (const line of lines) {
						if (line.startsWith("event: ")) {
							currentEvent = line.slice(7);
						} else if (line.startsWith("data: ")) {
							const raw = line.slice(6);
							try {
								const data = JSON.parse(raw);

								if (currentEvent === "progress" && data.message) {
									setConnection((prev) => ({ ...prev, progressMessage: data.message }));
								} else if (currentEvent === "done" && data.success) {
									const repoName = extractRepoName(repoUrl);
									setConnection({
										status: "connected",
										sessionId: data.sessionId,
										commitish: data.commitish,
										error: null,
										repoName,
										progressMessage: null,
									});
									localStorage.setItem("askforge_repo_url", repoUrl);
									setPhase("ask");
									setMessages([]);
									session.fetchSessionHistory();
								} else if (currentEvent === "error") {
									setConnection((prev) => ({
										...prev,
										status: "error",
										error: data.error || "Failed to connect",
										progressMessage: null,
									}));
								}
							} catch {
								/* ignore malformed JSON */
							}
							currentEvent = "";
						}
					}
				}
			} catch (err) {
				setConnection((prev) => ({
					...prev,
					status: "error",
					error: err instanceof Error ? err.message : "Network error",
					progressMessage: null,
				}));
			}
		},
		[session.fetchSessionHistory],
	);

	const handleConnect = useCallback(() => {
		if (!url.trim()) return;
		connectToRepo(url.trim());
	}, [url, connectToRepo]);

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
			progressMessage: null,
		});
		setMessages([]);
		setPhase("connect");
		// Clear initial session ID so we don't show "restoring" spinner
		setInitialSessionId(null);
		restoringFromUrlRef.current = false;
	}, [connection.sessionId]);

	const handleSend = useCallback(
		(questionOverride?: string) => {
			const question = (questionOverride || inputValue).trim();
			if (!question || !connection.sessionId || isAsking || currentRequestIdRef.current !== null) return;

			const requestId = generateRequestId();

			setInputValue("");
			setIsAsking(true);
			setProgress({ type: "thinking" });

			if (phase === "ask") {
				setPhase("chat");
			}

			const userMessage: Message = {
				id: `user-${Date.now()}`,
				role: "user",
				contentBlocks: [{ type: "text", content: question }],
			};
			setMessages((prev) => [...prev, userMessage]);

			currentRequestIdRef.current = requestId;
			pendingMessageRef.current = { requestId, sessionId: connection.sessionId, question };
			requestToSessionRef.current.set(requestId, connection.sessionId);
			sessionRequestRef.current.set(connection.sessionId, requestId);

			connectWebSocket();

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				wsRef.current.send(JSON.stringify({ type: "ask", ...pendingMessageRef.current }));
			}
		},
		[
			inputValue,
			connection.sessionId,
			isAsking,
			phase,
			generateRequestId,
			connectWebSocket,
			wsRef,
			currentRequestIdRef,
			pendingMessageRef,
			requestToSessionRef,
			sessionRequestRef,
		],
	);

	const handleResend = useCallback(
		(question: string) => {
			if (!connection.sessionId || isAsking || currentRequestIdRef.current !== null) return;

			const requestId = generateRequestId();

			setIsAsking(true);
			setProgress({ type: "thinking" });

			const userMessage: Message = {
				id: `user-${Date.now()}`,
				role: "user",
				contentBlocks: [{ type: "text", content: question }],
			};
			setMessages((prev) => [...prev, userMessage]);

			currentRequestIdRef.current = requestId;
			pendingMessageRef.current = { requestId, sessionId: connection.sessionId, question };
			requestToSessionRef.current.set(requestId, connection.sessionId);
			sessionRequestRef.current.set(connection.sessionId, requestId);

			connectWebSocket();

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				wsRef.current.send(JSON.stringify({ type: "ask", ...pendingMessageRef.current }));
			}
		},
		[
			connection.sessionId,
			isAsking,
			generateRequestId,
			connectWebSocket,
			wsRef,
			currentRequestIdRef,
			pendingMessageRef,
			requestToSessionRef,
			sessionRequestRef,
		],
	);

	const handleCancel = useCallback(() => {
		const requestId = currentRequestIdRef.current;
		if (requestId && wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "cancel", requestId }));
		}

		// Immediately clean up ALL streaming messages without waiting for server response
		setMessages((prev) => prev.map((msg) => (msg.isStreaming ? { ...msg, isStreaming: false } : msg)));

		streaming.streamingMessageIdRef.current = null;
		streaming.streamingThinkingRef.current = "";
		streaming.streamingBlocksRef.current = [];
		streaming.textBufferRef.current = "";
		streaming.stopReleaseLoop();

		currentRequestIdRef.current = null;
		pendingMessageRef.current = null;
		setIsAsking(false);
		setProgress({ type: "idle" });
	}, [wsRef, currentRequestIdRef, streaming, pendingMessageRef, setMessages, setIsAsking, setProgress]);

	const handleStartEdit = useCallback((messageId: string, currentContent: string) => {
		setEditingMessageId(messageId);
		setEditValue(currentContent);
	}, []);

	const handleCancelEdit = useCallback(() => {
		setEditingMessageId(null);
		setEditValue("");
	}, []);

	const handleSaveEdit = useCallback(
		(messageId: string) => {
			if (!editValue.trim()) return;

			// Find the message index
			const msgIndex = messages.findIndex((m) => m.id === messageId);
			if (msgIndex === -1) return;

			// Remove all messages after this one (including the message itself)
			setMessages((prev) => prev.slice(0, msgIndex));

			// Clear editing state
			setEditingMessageId(null);
			setEditValue("");

			// Send the edited message
			handleSend(editValue.trim());
		},
		[messages, editValue, handleSend],
	);

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

	const handleShareSession = useCallback(async (sessionId: string) => {
		try {
			const res = await fetch(`/api/sessions/${sessionId}/share`, { method: "POST" });
			const data = await res.json();
			if (!res.ok) {
				console.error("Share API error:", data);
				return;
			}
			const shareUrl = `${window.location.origin}${data.shareUrl}`;
			try {
				await navigator.clipboard.writeText(shareUrl);
			} catch {
				// Clipboard API may fail if not HTTPS — use prompt fallback
				window.prompt("Copy this share link:", shareUrl);
			}
			const el = document.createElement("div");
			el.className = "share-toast";
			el.textContent = "Share link copied to clipboard!";
			document.body.appendChild(el);
			setTimeout(() => el.remove(), 2500);
		} catch (err) {
			console.error("Share failed:", err);
		}
	}, []);

	const handleMessagesScroll = useCallback(() => {
		if (isProgrammaticScrollRef.current) return;
		const container = messagesContainerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		const isAtBottom = distanceFromBottom < 50;

		// Detect scroll direction
		const scrolledUp = scrollTop < lastScrollTopRef.current;
		lastScrollTopRef.current = scrollTop;

		// If user scrolled up, immediately disable auto-scroll
		// Only re-enable when they scroll back to the bottom
		if (scrolledUp && !isAtBottom) {
			shouldAutoScrollRef.current = false;
			setIsAutoScrolling(false);
		} else if (isAtBottom) {
			shouldAutoScrollRef.current = true;
			setIsAutoScrolling(true);
		}
	}, []);

	// --- Effects ---

	// Check for session permalink on mount (/c/:sessionId)
	// Use state so it can be cleared when user navigates away
	const [initialSessionId, setInitialSessionId] = useState<string | null>(() => getSessionIdFromUrl());
	const restoringFromUrlRef = useRef(false);

	// Auto-restore session from URL permalink
	useEffect(() => {
		if (!initialSessionId || !auth.authenticated || restoringFromUrlRef.current) return;
		if (connection.sessionId === initialSessionId) return; // Already restored

		// Wait for session history to load
		if (session.historyLoading) return;

		// Find the session in history and restore it
		const sessionToRestore = session.sessionHistory.find((s) => s.id === initialSessionId);
		if (sessionToRestore) {
			restoringFromUrlRef.current = true;
			session.handleRestore(sessionToRestore);
		} else if (session.sessionHistory.length > 0) {
			// Session not found in history - it might not belong to this user or doesn't exist
			// Redirect to home
			window.history.replaceState({}, "", "/");
		}
	}, [initialSessionId, auth.authenticated, session.sessionHistory, session.historyLoading, connection.sessionId]);

	// Update URL when session changes (but not on initial load from permalink)
	useEffect(() => {
		// Don't update URL while we're trying to restore from a permalink
		if (initialSessionId && connection.sessionId !== initialSessionId) {
			return;
		}

		if (!connection.sessionId) {
			// Only update URL if we're not already on home and not waiting to restore
			if (window.location.pathname !== "/" && !window.location.pathname.startsWith("/share/") && !initialSessionId) {
				window.history.replaceState({}, "", "/");
			}
			return;
		}

		const expectedPath = `/c/${connection.sessionId}`;
		if (window.location.pathname !== expectedPath) {
			window.history.replaceState({}, "", expectedPath);
		}
	}, [connection.sessionId, initialSessionId]);

	// Bookmarklet error message
	const [bookmarkletError, setBookmarkletError] = useState<string | null>(null);
	// URL to auto-connect to (from /go bookmarklet) - use ref to avoid stale closure issues
	const autoConnectUrlRef = useRef<string | null>(null);

	// Load URL from query param or localStorage on mount
	useEffect(() => {
		// Skip if we're restoring from a session permalink
		if (initialSessionId) return;

		const params = new URLSearchParams(window.location.search);
		const repoParam = params.get("repo");
		const autoParam = params.get("auto");
		const errorParam = params.get("error");

		// Handle bookmarklet errors
		if (errorParam) {
			if (errorParam === "not-logged-in") {
				setBookmarkletError("Please sign in first, then try the bookmarklet again.");
			} else if (errorParam === "no-referer") {
				setBookmarkletError(
					"Could not detect which page you came from. Try clicking the bookmarklet directly from a repository page.",
				);
			} else if (errorParam === "not-a-repo") {
				setBookmarkletError("The page you came from doesn't appear to be a code repository.");
			}
			// Clear error after a delay
			setTimeout(() => setBookmarkletError(null), 8000);
			// Clean up URL
			window.history.replaceState({}, "", window.location.pathname);
			return;
		}

		if (repoParam) {
			setUrl(repoParam);
			if (autoParam === "1") {
				// Store in ref to avoid stale closure issues with handleConnect
				autoConnectUrlRef.current = repoParam;
			}
			// Clean up the URL
			window.history.replaceState({}, "", window.location.pathname);
		} else {
			const savedUrl = localStorage.getItem("askforge_repo_url");
			if (savedUrl) setUrl(savedUrl);
		}
	}, [initialSessionId]);

	// Auto-connect when redirected from /go bookmarklet
	useEffect(() => {
		const autoConnectUrl = autoConnectUrlRef.current;
		if (autoConnectUrl && auth.authenticated && connection.status === "disconnected") {
			autoConnectUrlRef.current = null; // Clear to prevent re-triggering

			// Show the URL in the input field while connecting — reuse handleConnect
			setUrl(autoConnectUrl);
			connectToRepo(autoConnectUrl);
		}
	}, [auth.authenticated, connection.status, session.fetchSessionHistory]);

	// Fetch build info on mount
	useEffect(() => {
		fetch("/build-info.json")
			.then((res) => res.json())
			.then((data) => setBuildTime(data.buildTime))
			.catch(() => {});
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

	// Refresh session history when a question finishes (picks up auto-generated titles)
	const wasAskingRef = useRef(false);
	useEffect(() => {
		if (wasAskingRef.current && !isAsking && phase === "chat") {
			session.fetchSessionHistory();
		}
		wasAskingRef.current = isAsking;
	}, [isAsking, phase, session.fetchSessionHistory]);

	// Auto-scroll to bottom when messages change (throttled)
	useEffect(() => {
		if (!shouldAutoScrollRef.current) return;

		const now = Date.now();
		const timeSinceLastScroll = now - lastAutoScrollTimeRef.current;

		// Throttle scrolling to avoid too-frequent jumps during streaming
		if (timeSinceLastScroll < autoScrollThrottleMs) {
			// Schedule a scroll at the end of the throttle window
			const timeoutId = setTimeout(() => {
				if (!shouldAutoScrollRef.current) return;
				const container = messagesContainerRef.current;
				if (!container) return;

				isProgrammaticScrollRef.current = true;
				container.scrollTop = container.scrollHeight;
				lastScrollTopRef.current = container.scrollTop;
				lastAutoScrollTimeRef.current = Date.now();

				requestAnimationFrame(() => {
					isProgrammaticScrollRef.current = false;
				});
			}, autoScrollThrottleMs - timeSinceLastScroll);

			return () => clearTimeout(timeoutId);
		}

		const container = messagesContainerRef.current;
		if (!container) return;

		isProgrammaticScrollRef.current = true;
		container.scrollTop = container.scrollHeight;
		lastScrollTopRef.current = container.scrollTop;
		lastAutoScrollTimeRef.current = now;

		requestAnimationFrame(() => {
			isProgrammaticScrollRef.current = false;
		});
	}, [messages]);

	// --- Sidebar props ---

	const sidebarProps: React.ComponentProps<typeof Sidebar> = {
		auth,
		sidebarCollapsed,
		setSidebarCollapsed,
		sessionHistory: session.sessionHistory,
		historyLoading: session.historyLoading,
		renamingSession: session.renamingSession,
		renameValue: session.renameValue,
		setRenamingSession: session.setRenamingSession,
		setRenameValue: session.setRenameValue,
		handleDisconnect,
		handleLogout,
		refreshAuth,
		handleRestore: session.handleRestore,
		handleDeleteSession: session.handleDeleteSession,
		handleRenameSession: session.handleRenameSession,
	};

	// --- Render ---

	// Show loading when restoring session from URL permalink
	if (initialSessionId && connection.sessionId !== initialSessionId && auth.authenticated) {
		return (
			<div className="app-container phase-connect">
				<div className="app-main">
					<div className="connect-content">
						<h1 className="logo">
							<span className="logo-ask">ask</span>
							<span className="logo-forge">forge</span>
						</h1>
						<div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
							<span className="spinner" />
						</div>
						<p className="hint">Restoring session...</p>
					</div>
				</div>
			</div>
		);
	}

	if (phase === "connect") {
		return (
			<ConnectPhase
				auth={auth}
				connection={connection}
				url={url}
				setUrl={setUrl}
				buildTime={buildTime}
				bookmarkletError={bookmarkletError}
				handleConnect={handleConnect}
				handleLogin={handleLogin}
				handleLogout={handleLogout}
				handleKeyDown={handleKeyDown}
				urlInputRef={urlInputRef}
				sidebarProps={sidebarProps}
			/>
		);
	}

	if (phase === "ask") {
		return (
			<AskPhase
				connection={connection}
				inputValue={inputValue}
				setInputValue={setInputValue}
				isAsking={isAsking}
				handleKeyDown={handleKeyDown}
				handleSend={handleSend}
				handleDisconnect={handleDisconnect}
				askTextareaRef={askTextareaRef}
				sidebarProps={sidebarProps}
			/>
		);
	}

	return (
		<ChatPhase
			sessionTitle={session.currentSessionTitle}
			connection={connection}
			messages={messages}
			inputValue={inputValue}
			setInputValue={setInputValue}
			isAsking={isAsking}
			isAutoScrolling={isAutoScrolling}
			progress={progress}
			votes={votes}
			copiedId={copiedId}
			markedWithLinks={markedWithLinks}
			handleCopyMessage={handleCopyMessage}
			handleVote={handleVote}
			handleSend={handleSend}
			handleResend={handleResend}
			handleCancel={handleCancel}
			editingMessageId={editingMessageId}
			editValue={editValue}
			setEditValue={setEditValue}
			handleStartEdit={handleStartEdit}
			handleSaveEdit={handleSaveEdit}
			handleCancelEdit={handleCancelEdit}
			handleKeyDown={handleKeyDown}
			handleShareSession={handleShareSession}
			messagesContainerRef={messagesContainerRef}
			messagesEndRef={messagesEndRef}
			handleMessagesScroll={handleMessagesScroll}
			chatTextareaRef={chatTextareaRef}
			sidebarProps={sidebarProps}
		/>
	);
}
