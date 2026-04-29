import { useCallback, useRef } from "react";
import type { ContentBlock, Message } from "../types.ts";

const CHARS_PER_TICK = 2; // Base chars to release per tick (~120 chars/sec at 60fps)
const TICK_MS = 16; // ~60fps

export function useStreaming(setMessages: React.Dispatch<React.SetStateAction<Message[]>>) {
	const streamingMessageIdRef = useRef<string | null>(null);
	const streamingThinkingRef = useRef("");
	const streamingBlocksRef = useRef<ContentBlock[]>([]);
	const textBufferRef = useRef("");
	const releaseIntervalRef = useRef<number | null>(null);

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
	}, [setMessages]);

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

	return {
		streamingMessageIdRef,
		streamingThinkingRef,
		streamingBlocksRef,
		textBufferRef,
		releaseIntervalRef,
		updateStreamingUI,
		startReleaseLoop,
		stopReleaseLoop,
		flushTextBuffer,
	};
}
