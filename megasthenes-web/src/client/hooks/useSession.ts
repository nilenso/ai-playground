import { useCallback, useEffect, useState } from "react";
import type { ConnectionState, ContentBlock, Message, ProgressState, SessionSummary } from "../types.ts";

interface UseSessionOptions {
	authenticated: boolean;
	setConnection: React.Dispatch<React.SetStateAction<ConnectionState>>;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setPhase: React.Dispatch<React.SetStateAction<"connect" | "ask" | "chat">>;
	setUrl: React.Dispatch<React.SetStateAction<string>>;
	setIsAsking: React.Dispatch<React.SetStateAction<boolean>>;
	setProgress: React.Dispatch<React.SetStateAction<ProgressState>>;
	currentRequestIdRef: React.MutableRefObject<string | null>;
	pendingMessageRef: React.MutableRefObject<{ requestId: string; sessionId: string; question: string } | null>;
	requestToSessionRef: React.MutableRefObject<Map<string, string>>;
	sessionRequestRef: React.MutableRefObject<Map<string, string>>;
	streamingMessageIdRef: React.MutableRefObject<string | null>;
	streamingThinkingRef: React.MutableRefObject<string>;
	streamingBlocksRef: React.MutableRefObject<ContentBlock[]>;
	textBufferRef: React.MutableRefObject<string>;
	releaseIntervalRef: React.MutableRefObject<number | null>;
	connectionSessionId: string | null;
	resumeStreaming: (sessionId: string) => void;
}

export function useSession({
	authenticated,
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
	streamingMessageIdRef,
	streamingThinkingRef,
	streamingBlocksRef,
	textBufferRef,
	releaseIntervalRef,
	connectionSessionId,
	resumeStreaming,
}: UseSessionOptions) {
	const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [renamingSession, setRenamingSession] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const fetchSessionHistory = useCallback(() => {
		if (!authenticated) return;
		setHistoryLoading(true);
		fetch("/api/sessions")
			.then((res) => res.json())
			.then((data) => setSessionHistory(data))
			.catch(() => {})
			.finally(() => setHistoryLoading(false));
	}, [authenticated]);

	// Fetch session history when authenticated
	useEffect(() => {
		fetchSessionHistory();
	}, [fetchSessionHistory]);

	const handleRestore = useCallback(
		async (session: SessionSummary) => {
			// Stop the text release loop for the current session's streaming
			if (releaseIntervalRef.current !== null) {
				clearInterval(releaseIntervalRef.current);
				releaseIntervalRef.current = null;
			}

			// Reset client-side streaming state so the new session starts clean
			currentRequestIdRef.current = null;
			pendingMessageRef.current = null;
			streamingMessageIdRef.current = null;
			streamingThinkingRef.current = "";
			streamingBlocksRef.current = [];
			textBufferRef.current = "";
			setIsAsking(false);
			setProgress({ type: "idle" });

			setConnection((prev) => ({ ...prev, status: "connecting", error: null }));

			try {
				const restoreRes = await fetch("/api/restore", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId: session.id }),
				});
				const restoreData = await restoreRes.json();
				if (!restoreData.success) {
					setConnection((prev) => ({ ...prev, status: "error", error: restoreData.error || "Failed to restore" }));
					return;
				}

				// Fetch messages
				const msgRes = await fetch(`/api/sessions/${session.id}/messages`);
				const dbMessages: { role: string; content: string | null }[] = await msgRes.json();

				// Convert DB messages to client Messages
				// Merge consecutive assistant messages into one (agentic loop creates multiple turns)
				const clientMessages: Message[] = [];
				for (const msg of dbMessages) {
					if (msg.role === "user" && msg.content) {
						clientMessages.push({
							id: `user-${clientMessages.length}`,
							role: "user",
							contentBlocks: [{ type: "text", content: msg.content }],
						});
					} else if (msg.role === "assistant" && msg.content) {
						try {
							const blocks: ContentBlock[] = [];
							const parsed = JSON.parse(msg.content);
							if (Array.isArray(parsed)) {
								for (const block of parsed) {
									if (block.type === "text" && typeof block.text === "string") {
										blocks.push({ type: "text", content: block.text });
									} else if (block.type === "toolCall" || block.type === "tool_use") {
										blocks.push({
											type: "tool_call",
											name: block.name || block.toolName || "unknown",
											arguments: block.arguments || block.input || {},
											isComplete: true,
										});
									}
								}
							}
							if (blocks.length > 0) {
								// Merge with previous assistant message if exists
								const lastMsg = clientMessages[clientMessages.length - 1];
								if (lastMsg && lastMsg.role === "assistant") {
									lastMsg.contentBlocks = [...lastMsg.contentBlocks, ...blocks];
								} else {
									clientMessages.push({
										id: `assistant-${clientMessages.length}`,
										role: "assistant",
										contentBlocks: blocks,
									});
								}
							}
						} catch {
							const lastMsg = clientMessages[clientMessages.length - 1];
							if (lastMsg && lastMsg.role === "assistant") {
								lastMsg.contentBlocks.push({ type: "text", content: msg.content });
							} else {
								clientMessages.push({
									id: `assistant-${clientMessages.length}`,
									role: "assistant",
									contentBlocks: [{ type: "text", content: msg.content }],
								});
							}
						}
					}
				}

				const repoName = `${session.username_or_organization}/${session.repository_name}`;
				setUrl(session.git_url);
				setConnection({
					status: "connected",
					sessionId: restoreData.sessionId,
					commitish: restoreData.commitish,
					error: null,
					repoName,
					progressMessage: null,
				});
				setMessages(clientMessages);
				setPhase(clientMessages.length > 0 ? "chat" : "ask");
				fetchSessionHistory();

				// Check if this session has an in-flight request we should resume streaming for
				// First check server-side (handles page refresh case)
				if (restoreData.activeRequest) {
					// Add the user's question as a message if not already present
					const questionAlreadyShown = clientMessages.some(
						(m) =>
							m.role === "user" &&
							m.contentBlocks.some((b) => b.type === "text" && b.content === restoreData.activeRequest.question),
					);
					if (!questionAlreadyShown) {
						setMessages((prev) => [
							...prev,
							{
								id: `user-${Date.now()}`,
								role: "user",
								contentBlocks: [{ type: "text", content: restoreData.activeRequest.question }],
							},
						]);
					}
					// Resume streaming from server buffer
					resumeStreaming(session.id);
					setPhase("chat");
				} else {
					// Check client-side tracking (handles tab switching case)
					const activeRequestId = sessionRequestRef.current.get(session.id);
					if (activeRequestId && requestToSessionRef.current.has(activeRequestId)) {
						currentRequestIdRef.current = activeRequestId;
						setIsAsking(true);
						setProgress({ type: "thinking" });
					}
				}
			} catch (err) {
				setConnection((prev) => ({
					...prev,
					status: "error",
					error: err instanceof Error ? err.message : "Network error",
				}));
			}
		},
		[
			fetchSessionHistory,
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
			streamingMessageIdRef,
			streamingThinkingRef,
			streamingBlocksRef,
			textBufferRef,
			releaseIntervalRef,
			resumeStreaming,
		],
	);

	const handleDeleteSession = useCallback(
		async (sessionId: string) => {
			try {
				await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
				if (connectionSessionId === sessionId) {
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
				}
				setSessionHistory((prev) => prev.filter((s) => s.id !== sessionId));
			} catch {
				// Ignore
			}
		},
		[connectionSessionId, setConnection, setMessages, setPhase],
	);

	const handleRenameSession = useCallback(async (sessionId: string, title: string) => {
		if (!title.trim()) return;
		try {
			await fetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: title.trim() }),
			});
			setSessionHistory((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title: title.trim() } : s)));
		} catch {
			// Ignore
		}
		setRenamingSession(null);
	}, []);

	const currentSessionTitle = connectionSessionId
		? (sessionHistory.find((s) => s.id === connectionSessionId)?.title ?? null)
		: null;

	return {
		sessionHistory,
		historyLoading,
		renamingSession,
		renameValue,
		currentSessionTitle,
		setRenamingSession,
		setRenameValue,
		fetchSessionHistory,
		handleRestore,
		handleDeleteSession,
		handleRenameSession,
	};
}
