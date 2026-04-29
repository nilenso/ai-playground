import type { Marked } from "marked";
import { useEffect, useRef } from "react";
import type { ContentBlock, Message, ProgressState } from "../types.ts";
import { formatToolCall } from "../utils.ts";

interface MessageListProps {
	messages: Message[];
	isAsking: boolean;
	isAutoScrolling: boolean;
	progress: ProgressState;
	votes: Record<string, "like" | "dislike">;
	copiedId: string | null;
	markedWithLinks: Marked;
	handleCopyMessage: (msgId: string, blocks: ContentBlock[]) => void;
	handleResend: (question: string) => void;
	editingMessageId: string | null;
	editValue: string;
	setEditValue: (value: string) => void;
	handleStartEdit: (messageId: string, currentContent: string) => void;
	handleSaveEdit: (messageId: string) => void;
	handleCancelEdit: () => void;
	handleVote: (msgId: string, vote: "like" | "dislike") => void;
	messagesContainerRef: React.RefObject<HTMLDivElement | null>;
	messagesEndRef: React.RefObject<HTMLDivElement | null>;
	handleMessagesScroll: () => void;
}

export function MessageList({
	messages,
	isAsking,
	isAutoScrolling,
	progress,
	votes,
	copiedId,
	markedWithLinks,
	handleCopyMessage,
	handleResend,
	editingMessageId,
	editValue,
	setEditValue,
	handleStartEdit,
	handleSaveEdit,
	handleCancelEdit,
	handleVote,
	messagesContainerRef,
	messagesEndRef,
	handleMessagesScroll,
}: MessageListProps) {
	const isStreaming = messages.some((m) => m.isStreaming);
	const showStreamingGlow = isAsking || isStreaming;
	const editTextareaRef = useRef<HTMLTextAreaElement>(null);

	// Set cursor to end when entering edit mode
	useEffect(() => {
		if (editingMessageId && editTextareaRef.current) {
			const textarea = editTextareaRef.current;
			const length = textarea.value.length;
			textarea.setSelectionRange(length, length);
		}
	}, [editingMessageId]);

	return (
		<div className="messages-wrapper">
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
						{msg.role === "user" ? (
							editingMessageId === msg.id ? (
								<div className="message-edit-container">
									<textarea
										ref={editTextareaRef}
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										className="message-edit-textarea"
										rows={4}
										onKeyDown={(e) => {
											if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
												handleSaveEdit(msg.id);
											} else if (e.key === "Escape") {
												handleCancelEdit();
											}
										}}
									/>
									<div className="message-edit-actions">
										<button type="button" className="message-edit-cancel" onClick={handleCancelEdit}>
											Cancel
										</button>
										<button
											type="button"
											className="message-edit-save"
											onClick={() => handleSaveEdit(msg.id)}
											disabled={!editValue.trim()}
										>
											Save & Submit
										</button>
									</div>
								</div>
							) : (
								<>
									{msg.contentBlocks.map((block, idx) =>
										block.type === "text" ? (
											<div
												key={`${msg.id}-text-${idx}`}
												className="markdown-content"
												// biome-ignore lint/security/noDangerouslySetInnerHtml: marked output for rendered LLM markdown
												dangerouslySetInnerHTML={{ __html: markedWithLinks.parse(block.content) as string }}
											/>
										) : null,
									)}
									{!isAsking && (
										<div className="message-actions">
											<button
												type="button"
												title={copiedId === msg.id ? "Copied!" : "Copy"}
												onClick={() => handleCopyMessage(msg.id, msg.contentBlocks)}
											>
												{copiedId === msg.id ? (
													<svg
														xmlns="http://www.w3.org/2000/svg"
														fill="none"
														viewBox="0 0 24 24"
														strokeWidth={1.5}
														stroke="currentColor"
														role="img"
														aria-label="Copied"
													>
														<title>Copied</title>
														<path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
													</svg>
												) : (
													<svg
														xmlns="http://www.w3.org/2000/svg"
														fill="none"
														viewBox="0 0 24 24"
														strokeWidth={1.5}
														stroke="currentColor"
														role="img"
														aria-label="Copy"
													>
														<title>Copy</title>
														<path
															strokeLinecap="round"
															strokeLinejoin="round"
															d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"
														/>
													</svg>
												)}
											</button>
											<button
												type="button"
												title="Edit"
												onClick={() => {
													const text = msg.contentBlocks
														.filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
														.map((b) => b.content)
														.join("\n\n");
													handleStartEdit(msg.id, text);
												}}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													viewBox="0 0 24 24"
													strokeWidth={1.5}
													stroke="currentColor"
													role="img"
													aria-label="Edit"
												>
													<title>Edit</title>
													<path
														strokeLinecap="round"
														strokeLinejoin="round"
														d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
													/>
												</svg>
											</button>
											<button
												type="button"
												title="Resend"
												onClick={() => {
													const text = msg.contentBlocks
														.filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
														.map((b) => b.content)
														.join("\n\n");
													handleResend(text);
												}}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													viewBox="0 0 24 24"
													strokeWidth={1.5}
													stroke="currentColor"
													role="img"
													aria-label="Resend"
												>
													<title>Resend</title>
													<path
														strokeLinecap="round"
														strokeLinejoin="round"
														d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
													/>
												</svg>
											</button>
										</div>
									)}
								</>
							)
						) : (
							msg.contentBlocks.map((block, idx) =>
								block.type === "text" ? (
									<div
										key={`${msg.id}-text-${idx}`}
										className="markdown-content"
										// biome-ignore lint/security/noDangerouslySetInnerHtml: marked output for rendered LLM markdown
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
							)
						)}
						{msg.role === "assistant" && !isAsking && (
							<div className="message-actions">
								<button
									type="button"
									title={copiedId === msg.id ? "Copied!" : "Copy"}
									onClick={() => handleCopyMessage(msg.id, msg.contentBlocks)}
								>
									{copiedId === msg.id ? (
										<svg
											xmlns="http://www.w3.org/2000/svg"
											fill="none"
											viewBox="0 0 24 24"
											strokeWidth={1.5}
											stroke="currentColor"
											role="img"
											aria-label="Copied"
										>
											<title>Copied</title>
											<path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
										</svg>
									) : (
										<svg
											xmlns="http://www.w3.org/2000/svg"
											fill="none"
											viewBox="0 0 24 24"
											strokeWidth={1.5}
											stroke="currentColor"
											role="img"
											aria-label="Copy"
										>
											<title>Copy</title>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"
											/>
										</svg>
									)}
								</button>
								<button
									type="button"
									title="Thumbs up"
									className={votes[msg.id] === "like" ? "active" : ""}
									onClick={() => handleVote(msg.id, "like")}
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										strokeWidth={1.5}
										stroke="currentColor"
										role="img"
										aria-label="Thumbs up"
									>
										<title>Thumbs up</title>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											d="M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75a.75.75 0 0 1 .75-.75 2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 0 1-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 0 0-1.423-.23H3.75"
										/>
									</svg>
								</button>
								<button
									type="button"
									title="Thumbs down"
									className={votes[msg.id] === "dislike" ? "active" : ""}
									onClick={() => handleVote(msg.id, "dislike")}
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										strokeWidth={1.5}
										stroke="currentColor"
										role="img"
										aria-label="Thumbs down"
									>
										<title>Thumbs down</title>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											d="M17.367 13.75c-.806 0-1.533.446-2.031 1.08a9.041 9.041 0 0 1-2.861 2.4c-.723.384-1.35.956-1.653 1.715a4.498 4.498 0 0 0-.322 1.672v.633a.75.75 0 0 1-.75.75 2.25 2.25 0 0 1-2.25-2.25c0-1.152.26-2.243.723-3.218.266-.558-.107-1.282-.725-1.282m0 0H4.372c-1.026 0-1.945-.694-2.054-1.715A12.134 12.134 0 0 1 2.25 12c0-2.848.992-5.464 2.649-7.521C5.287 3.997 5.886 3.75 6.504 3.75h4.016c.483 0 .964.078 1.423.23l3.114 1.04a4.501 4.501 0 0 0 1.423.23h2.27"
										/>
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
							{progress.type === "compaction" && (
								<>
									<span className="compaction-icon">📝</span>
									Compacting context...
									{progress.tokensBefore && progress.tokensAfter && (
										<span className="compaction-info">
											{" "}
											({progress.tokensBefore.toLocaleString()} → {progress.tokensAfter.toLocaleString()} tokens)
										</span>
									)}
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
			{showStreamingGlow && <div className={`streaming-glow ${isAutoScrolling ? "streaming-glow-emphatic" : ""}`} />}
		</div>
	);
}
