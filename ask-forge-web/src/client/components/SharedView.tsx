import { useEffect, useMemo, useState } from "react";
import { createMarkedWithFileLinks } from "../file-linker.ts";
import type { ContentBlock, Message } from "../types.ts";
import { formatToolCall } from "../utils.ts";

interface SharedSession {
	title: string | null;
	repoName: string;
	gitUrl: string;
	commitish: string | null;
	createdAt: string;
}

interface DbMessage {
	id: number;
	session_id: string;
	role: string;
	content: string | null;
	thinking: string | null;
	tool_name: string | null;
	tool_arguments: string | null;
	tool_result: string | null;
	ordinal: number;
	created_at: string;
}

interface SharedViewProps {
	token: string;
}

/**
 * Convert DB messages to display messages (similar to how the chat works)
 */
function dbMessagesToDisplay(dbMessages: DbMessage[]): Message[] {
	const messages: Message[] = [];

	for (const msg of dbMessages) {
		if (msg.role === "user") {
			messages.push({
				id: `shared-user-${msg.id}`,
				role: "user",
				contentBlocks: [{ type: "text", content: msg.content ?? "" }],
			});
		} else if (msg.role === "assistant") {
			let blocks: ContentBlock[];
			try {
				const content = JSON.parse(msg.content ?? "[]");
				blocks = [];
				for (const item of content) {
					if (item.type === "text") {
						blocks.push({ type: "text", content: item.text ?? "" });
					} else if (item.type === "tool_use") {
						blocks.push({
							type: "tool_call",
							name: item.name ?? "",
							arguments: item.input ?? {},
							isComplete: true,
						});
					}
				}
				if (blocks.length === 0) {
					blocks = [{ type: "text", content: msg.content ?? "" }];
				}
			} catch {
				blocks = [{ type: "text", content: msg.content ?? "" }];
			}
			messages.push({
				id: `shared-assistant-${msg.id}`,
				role: "assistant",
				contentBlocks: blocks,
				thinking: msg.thinking ?? undefined,
			});
		}
		// Skip tool result messages - they're shown inline with tool calls
	}

	return messages;
}

export function SharedView({ token }: SharedViewProps) {
	const [session, setSession] = useState<SharedSession | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Fetch shared session data
	useEffect(() => {
		fetch(`/api/share/${token}`)
			.then((res) => {
				if (!res.ok) throw new Error("Share link not found");
				return res.json();
			})
			.then((data) => {
				setSession(data.session);
				setMessages(dbMessagesToDisplay(data.messages));
				setLoading(false);
			})
			.catch((err) => {
				setError(err.message);
				setLoading(false);
			});
	}, [token]);

	const markedWithLinks = useMemo(
		() => createMarkedWithFileLinks(session?.gitUrl, session?.commitish),
		[session?.gitUrl, session?.commitish],
	);

	const handleStartConversation = () => {
		if (!session) return;
		// Redirect to the main app with the repo URL pre-filled
		window.location.href = `/?repo=${encodeURIComponent(session.gitUrl)}`;
	};

	if (loading) {
		return (
			<div className="shared-view">
				<div className="shared-view-loading">
					<span className="spinner" />
				</div>
			</div>
		);
	}

	if (error || !session) {
		return (
			<div className="shared-view">
				<div className="shared-view-error">
					<h2>Session not found</h2>
					<p>{error || "This share link may have been removed or is invalid."}</p>
					<a href="/" className="shared-view-home-link">
						Go to Ask Forge
					</a>
				</div>
			</div>
		);
	}

	return (
		<div className="shared-view">
			<div className="shared-view-header">
				<div className="shared-view-header-left">
					<a href="/" className="shared-view-logo">
						<span className="logo-ask">ask</span>
						<span className="logo-forge">forge</span>
					</a>
					<span className="shared-view-divider">/</span>
					<span className="shared-view-title">{session.title || "Shared conversation"}</span>
				</div>
				<div className="shared-view-header-right">
					<span className="shared-view-repo">{session.repoName}</span>
					{session.commitish && <span className="commit-badge">{session.commitish.slice(0, 7)}</span>}
				</div>
			</div>

			<div className="shared-view-messages">
				{messages.map((msg) => (
					<div key={msg.id} className={`message message-${msg.role}`}>
						<div className="message-role">{msg.role === "user" ? "You" : "Assistant"}</div>
						{msg.thinking && (
							<details className="thinking-block">
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
								<details key={`${msg.id}-tool-${idx}`} className="tool-call-inline">
									<summary>
										<code>{formatToolCall(block.name, block.arguments)}</code>
									</summary>
									{Object.keys(block.arguments).length > 0 && <pre>{JSON.stringify(block.arguments, null, 2)}</pre>}
								</details>
							),
						)}
					</div>
				))}
			</div>

			<div className="shared-view-footer">
				<button type="button" className="shared-view-fork-button" onClick={handleStartConversation}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
						<path d="M12 5v14M5 12h14" />
					</svg>
					Start your own conversation
				</button>
			</div>
		</div>
	);
}
