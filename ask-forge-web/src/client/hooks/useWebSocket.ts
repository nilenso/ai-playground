import { useCallback, useEffect, useRef } from "react";
import type { ContentBlock, Message, ProgressState } from "../types.ts";

interface UseWebSocketOptions {
	streaming: {
		streamingMessageIdRef: React.MutableRefObject<string | null>;
		streamingThinkingRef: React.MutableRefObject<string>;
		streamingBlocksRef: React.MutableRefObject<ContentBlock[]>;
		textBufferRef: React.MutableRefObject<string>;
		releaseIntervalRef: React.MutableRefObject<number | null>;
		updateStreamingUI: () => void;
		startReleaseLoop: () => void;
		stopReleaseLoop: () => void;
		flushTextBuffer: () => void;
	};
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setIsAsking: React.Dispatch<React.SetStateAction<boolean>>;
	setProgress: React.Dispatch<React.SetStateAction<ProgressState>>;
	phaseRef: React.MutableRefObject<string>;
	chatTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function useWebSocket({
	streaming,
	setMessages,
	setIsAsking,
	setProgress,
	phaseRef,
	chatTextareaRef,
}: UseWebSocketOptions) {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectAttemptRef = useRef(0);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingMessageRef = useRef<{ requestId: string; sessionId: string; question: string } | null>(null);
	const currentRequestIdRef = useRef<string | null>(null);
	const requestToSessionRef = useRef<Map<string, string>>(new Map());
	const sessionRequestRef = useRef<Map<string, string>>(new Map());

	const {
		streamingMessageIdRef,
		streamingThinkingRef,
		streamingBlocksRef,
		textBufferRef,
		updateStreamingUI,
		startReleaseLoop,
		stopReleaseLoop,
		flushTextBuffer,
	} = streaming;

	// Generate unique request ID
	const generateRequestId = useCallback(() => {
		return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}, []);

	// WebSocket message handler
	const handleWsMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const message = JSON.parse(event.data);

				// Ignore messages for background sessions (server persists to DB anyway)
				if (message.requestId && message.requestId !== currentRequestIdRef.current) {
					const msgSessionId = requestToSessionRef.current.get(message.requestId);
					// If this is a "done", "error", or "cancelled" message, clean up tracking for the background request
					if (message.type === "done" || message.type === "error" || message.type === "cancelled") {
						if (msgSessionId) {
							const tracked = sessionRequestRef.current.get(msgSessionId);
							if (tracked === message.requestId) {
								sessionRequestRef.current.delete(msgSessionId);
							}
						}
						requestToSessionRef.current.delete(message.requestId);
					}
					return;
				}

				if (message.type === "pong") {
					return;
				}

				if (message.type === "progress") {
					const data = message.data;

					// Initialize streaming message if needed
					if (!streamingMessageIdRef.current) {
						streamingMessageIdRef.current = `assistant-${Date.now()}`;
						streamingThinkingRef.current = "";
						streamingBlocksRef.current = [];

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
						streamingThinkingRef.current += data.delta;
						setProgress((prev) => ({ ...prev, type: "thinking" }));
						updateStreamingUI();
					} else if (data.type === "text_delta") {
						textBufferRef.current += data.delta;
						setProgress((prev) => ({ ...prev, type: "responding" }));
						startReleaseLoop();
					} else if (data.type === "tool_start") {
						flushTextBuffer();
						streamingBlocksRef.current = [
							...streamingBlocksRef.current,
							{ type: "tool_call", name: data.name, arguments: data.arguments || {}, isComplete: false },
						];
						updateStreamingUI();
						setProgress({ type: "tool", toolName: data.name, toolArgs: data.arguments });
					} else if (data.type === "tool_end") {
						flushTextBuffer();
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
					stopReleaseLoop();
					flushTextBuffer();

					const data = message.data;

					if (data.success) {
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
							const blocksToUse = streamingBlocksRef.current.length > 0 ? streamingBlocksRef.current : finalBlocks;
							setMessages((prev) =>
								prev.map((msg) =>
									msg.id === streamingMessageIdRef.current
										? { ...msg, contentBlocks: blocksToUse, isStreaming: false }
										: msg,
								),
							);
						} else {
							setMessages((prev) => [
								...prev,
								{ id: `assistant-${Date.now()}`, role: "assistant", contentBlocks: finalBlocks },
							]);
						}
					} else {
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

					// Clean up tracking maps
					if (message.requestId) {
						const sid = requestToSessionRef.current.get(message.requestId);
						if (sid) {
							const tracked = sessionRequestRef.current.get(sid);
							if (tracked === message.requestId) sessionRequestRef.current.delete(sid);
						}
						requestToSessionRef.current.delete(message.requestId);
					}

					currentRequestIdRef.current = null;
					pendingMessageRef.current = null;
					setIsAsking(false);
					setProgress({ type: "idle" });
					if (phaseRef.current === "chat") {
						chatTextareaRef.current?.focus();
					}
				} else if (message.type === "error") {
					stopReleaseLoop();

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

					streamingMessageIdRef.current = null;
					streamingThinkingRef.current = "";
					streamingBlocksRef.current = [];
					textBufferRef.current = "";

					if (message.requestId) {
						const sid = requestToSessionRef.current.get(message.requestId);
						if (sid) {
							const tracked = sessionRequestRef.current.get(sid);
							if (tracked === message.requestId) sessionRequestRef.current.delete(sid);
						}
						requestToSessionRef.current.delete(message.requestId);
					}

					currentRequestIdRef.current = null;
					pendingMessageRef.current = null;
					setIsAsking(false);
					setProgress({ type: "idle" });
				} else if (message.type === "cancelled") {
					stopReleaseLoop();

					if (streamingMessageIdRef.current) {
						setMessages((prev) => prev.filter((msg) => msg.id !== streamingMessageIdRef.current));
					}

					streamingMessageIdRef.current = null;
					streamingThinkingRef.current = "";
					streamingBlocksRef.current = [];
					textBufferRef.current = "";

					if (message.requestId) {
						const sid = requestToSessionRef.current.get(message.requestId);
						if (sid) {
							const tracked = sessionRequestRef.current.get(sid);
							if (tracked === message.requestId) sessionRequestRef.current.delete(sid);
						}
						requestToSessionRef.current.delete(message.requestId);
					}

					currentRequestIdRef.current = null;
					pendingMessageRef.current = null;
					setIsAsking(false);
					setProgress({ type: "idle" });
				}
			} catch {
				// Ignore JSON parse errors
			}
		},
		[
			setMessages,
			setIsAsking,
			setProgress,
			phaseRef,
			chatTextareaRef,
			streamingMessageIdRef,
			streamingThinkingRef,
			streamingBlocksRef,
			textBufferRef,
			updateStreamingUI,
			startReleaseLoop,
			stopReleaseLoop,
			flushTextBuffer,
		],
	);

	// Create/reconnect WebSocket with exponential backoff
	const connectWebSocket = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			return;
		}

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

			if (pendingMessageRef.current && reconnectAttemptRef.current < 5) {
				const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 30000);
				console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current + 1})`);
				reconnectAttemptRef.current++;
				reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
			} else if (pendingMessageRef.current) {
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
	}, [handleWsMessage, setMessages, setIsAsking, setProgress]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (streaming.releaseIntervalRef.current !== null) {
				clearInterval(streaming.releaseIntervalRef.current);
			}
			if (wsRef.current) {
				wsRef.current.close();
			}
		};
	}, [streaming.releaseIntervalRef]);

	return {
		wsRef,
		currentRequestIdRef,
		requestToSessionRef,
		sessionRequestRef,
		pendingMessageRef,
		reconnectTimeoutRef,
		connectWebSocket,
		generateRequestId,
	};
}
