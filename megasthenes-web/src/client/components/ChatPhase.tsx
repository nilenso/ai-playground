import type { Marked } from "marked";
import type { ConnectionState, ContentBlock, Message, ProgressState } from "../types.ts";
import { MessageList } from "./MessageList.tsx";
import { Sidebar } from "./Sidebar.tsx";

interface ChatPhaseProps {
	sessionTitle: string | null;
	connection: ConnectionState;
	messages: Message[];
	inputValue: string;
	setInputValue: (value: string) => void;
	isAsking: boolean;
	isAutoScrolling: boolean;
	progress: ProgressState;
	votes: Record<string, "like" | "dislike">;
	copiedId: string | null;
	markedWithLinks: Marked;
	handleCopyMessage: (msgId: string, blocks: ContentBlock[]) => void;
	handleVote: (msgId: string, vote: "like" | "dislike") => void;
	handleSend: () => void;
	handleResend: (question: string) => void;
	handleCancel: () => void;
	editingMessageId: string | null;
	editValue: string;
	setEditValue: (value: string) => void;
	handleStartEdit: (messageId: string, currentContent: string) => void;
	handleSaveEdit: (messageId: string) => void;
	handleCancelEdit: () => void;
	handleKeyDown: (e: React.KeyboardEvent) => void;
	handleShareSession: (sessionId: string) => void;
	messagesContainerRef: React.RefObject<HTMLDivElement | null>;
	messagesEndRef: React.RefObject<HTMLDivElement | null>;
	handleMessagesScroll: () => void;
	chatTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
	sidebarProps: React.ComponentProps<typeof Sidebar>;
}

export function ChatPhase({
	sessionTitle,
	connection,
	messages,
	inputValue,
	setInputValue,
	isAsking,
	isAutoScrolling,
	progress,
	votes,
	copiedId,
	markedWithLinks,
	handleCopyMessage,
	handleVote,
	handleSend,
	handleResend,
	handleCancel,
	editingMessageId,
	editValue,
	setEditValue,
	handleStartEdit,
	handleSaveEdit,
	handleCancelEdit,
	handleKeyDown,
	handleShareSession,
	messagesContainerRef,
	messagesEndRef,
	handleMessagesScroll,
	chatTextareaRef,
	sidebarProps,
}: ChatPhaseProps) {
	return (
		<div className="app-container phase-chat">
			<Sidebar {...sidebarProps} />
			<div className="app-main">
				<header className="chat-header">
					<div className="chat-header-info">
						{sessionTitle && <span className="chat-header-title">{sessionTitle}</span>}
						<span className="chat-header-subtitle">
							<svg
								className="forge-icon"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<circle cx="12" cy="18" r="3" />
								<circle cx="6" cy="6" r="3" />
								<circle cx="18" cy="6" r="3" />
								<path d="M18 9v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
								<line x1="12" y1="13" x2="12" y2="15" />
							</svg>
							{connection.repoName}
							{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
						</span>
					</div>
					{connection.sessionId && (
						<button
							type="button"
							className="share-button"
							onClick={() => {
								if (connection.sessionId) handleShareSession(connection.sessionId);
							}}
							title="Share this conversation"
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
								<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
								<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
							</svg>
							Share
						</button>
					)}
				</header>

				<main className="chat-main">
					<MessageList
						messages={messages}
						isAsking={isAsking}
						isAutoScrolling={isAutoScrolling}
						progress={progress}
						votes={votes}
						copiedId={copiedId}
						markedWithLinks={markedWithLinks}
						handleCopyMessage={handleCopyMessage}
						handleResend={handleResend}
						editingMessageId={editingMessageId}
						editValue={editValue}
						setEditValue={setEditValue}
						handleStartEdit={handleStartEdit}
						handleSaveEdit={handleSaveEdit}
						handleCancelEdit={handleCancelEdit}
						handleVote={handleVote}
						messagesContainerRef={messagesContainerRef}
						messagesEndRef={messagesEndRef}
						handleMessagesScroll={handleMessagesScroll}
					/>
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
						<button
							type="button"
							className={isAsking ? "stop-button" : "send-button"}
							onClick={isAsking ? handleCancel : handleSend}
							disabled={!isAsking && !inputValue.trim()}
						>
							{isAsking ? (
								<>
									<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none" aria-hidden="true">
										<rect x="6" y="6" width="12" height="12" rx="1" />
									</svg>
									Stop
								</>
							) : (
								"Send"
							)}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
