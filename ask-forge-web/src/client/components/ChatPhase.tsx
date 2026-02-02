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
	progress: ProgressState;
	votes: Record<string, "like" | "dislike">;
	copiedId: string | null;
	markedWithLinks: Marked;
	handleCopyMessage: (msgId: string, blocks: ContentBlock[]) => void;
	handleVote: (msgId: string, vote: "like" | "dislike") => void;
	handleSend: () => void;
	handleResend: (question: string) => void;
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
	progress,
	votes,
	copiedId,
	markedWithLinks,
	handleCopyMessage,
	handleVote,
	handleSend,
	handleResend,
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
							<span className="status-indicator connected" />
							{connection.repoName}
							{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
						</span>
					</div>
					{connection.sessionId && (
						<button
							type="button"
							className="share-button"
							onClick={() => handleShareSession(connection.sessionId!)}
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
						progress={progress}
						votes={votes}
						copiedId={copiedId}
						markedWithLinks={markedWithLinks}
						handleCopyMessage={handleCopyMessage}
						handleResend={handleResend}
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
							className="send-button"
							onClick={handleSend}
							disabled={isAsking || !inputValue.trim()}
						>
							{isAsking ? <span className="spinner small" /> : "Send"}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
