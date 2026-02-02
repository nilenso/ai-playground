import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskPhase } from "./components/AskPhase.tsx";
import { ChatPhase } from "./components/ChatPhase.tsx";
import { ConnectPhase } from "./components/ConnectPhase.tsx";
import type { Sidebar } from "./components/Sidebar.tsx";
import { createMarkedWithFileLinks } from "./file-linker.ts";
import { useAuth } from "./hooks/useAuth.ts";
import { useSession } from "./hooks/useSession.ts";
import { useStreaming } from "./hooks/useStreaming.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import type { AppPhase, ConnectionState, ContentBlock, Message, ProgressState } from "./types.ts";
import { extractRepoName } from "./utils.ts";

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

	const [votes, setVotes] = useState<Record<string, "like" | "dislike">>({});
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

	const urlInputRef = useRef<HTMLInputElement>(null);
	const askTextareaRef = useRef<HTMLTextAreaElement>(null);
	const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const shouldAutoScrollRef = useRef(true);
	const phaseRef = useRef(phase);
	phaseRef.current = phase;

	// --- Hooks ---

	const onLogout = useCallback(() => {
		setMessages([]);
		setInputValue("");
		setIsAsking(false);
		setProgress({ type: "idle" });
		setConnection({ status: "disconnected", sessionId: null, commitish: null, error: null, repoName: null });
		setPhase("connect");
	}, []);

	const { auth, handleLogin, handleLogout } = useAuth({
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

			localStorage.setItem("askforge_repo_url", url.trim());
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
		setConnection({ status: "disconnected", sessionId: null, commitish: null, error: null, repoName: null });
		setMessages([]);
		setPhase("connect");
	}, [connection.sessionId]);

	const handleSend = useCallback(() => {
		if (!inputValue.trim() || !connection.sessionId || isAsking) return;

		const question = inputValue.trim();
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
	}, [
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
	]);

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

	const handleMessagesScroll = useCallback(() => {
		const container = messagesContainerRef.current;
		if (!container) return;
		const { scrollTop, scrollHeight, clientHeight } = container;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		shouldAutoScrollRef.current = distanceFromBottom < 100;
	}, []);

	// --- Effects ---

	// Load URL from localStorage on mount
	useEffect(() => {
		const savedUrl = localStorage.getItem("askforge_repo_url");
		if (savedUrl) setUrl(savedUrl);
	}, []);

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

	// Auto-scroll to bottom when messages change
	useEffect(() => {
		if (shouldAutoScrollRef.current) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}
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
		handleRestore: session.handleRestore,
		handleDeleteSession: session.handleDeleteSession,
		handleRenameSession: session.handleRenameSession,
	};

	// --- Render ---

	if (phase === "connect") {
		return (
			<ConnectPhase
				auth={auth}
				connection={connection}
				url={url}
				setUrl={setUrl}
				buildTime={buildTime}
				handleConnect={handleConnect}
				handleLogin={handleLogin}
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
				handleDisconnect={handleDisconnect}
				askTextareaRef={askTextareaRef}
				sidebarProps={sidebarProps}
			/>
		);
	}

	return (
		<ChatPhase
			connection={connection}
			messages={messages}
			inputValue={inputValue}
			setInputValue={setInputValue}
			isAsking={isAsking}
			progress={progress}
			votes={votes}
			copiedId={copiedId}
			markedWithLinks={markedWithLinks}
			handleCopyMessage={handleCopyMessage}
			handleVote={handleVote}
			handleSend={handleSend}
			handleKeyDown={handleKeyDown}
			messagesContainerRef={messagesContainerRef}
			messagesEndRef={messagesEndRef}
			handleMessagesScroll={handleMessagesScroll}
			chatTextareaRef={chatTextareaRef}
			sidebarProps={sidebarProps}
		/>
	);
}
