import type { Marked } from "marked";
import type { ConnectionState, ContentBlock, Message, ProgressState } from "../types.ts";
import { MessageList } from "./MessageList.tsx";
import { Sidebar } from "./Sidebar.tsx";

interface ChatPhaseProps {
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
	messagesContainerRef: React.RefObject<HTMLDivElement | null>;
	messagesEndRef: React.RefObject<HTMLDivElement | null>;
	handleMessagesScroll: () => void;
	chatTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
	sidebarProps: React.ComponentProps<typeof Sidebar>;
}

export function ChatPhase({
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
					<div className="repo-status-inline">
						<span className="status-indicator connected" />
						<span className="repo-name">{connection.repoName}</span>
						{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
					</div>
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
