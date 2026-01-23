import { useState, useEffect } from "react";
import { marked } from "marked";

interface SessionEvent {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

interface SessionInfo {
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
}

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface MessageEvent extends SessionEvent {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: ContentBlock[];
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		api?: string;
		model?: string;
		usage?: {
			input: number;
			output: number;
			cost: { total: number };
		};
	};
}

interface ModelChangeEvent extends SessionEvent {
	type: "model_change";
	provider: string;
	modelId: string;
}

interface ThinkingLevelEvent extends SessionEvent {
	type: "thinking_level_change";
	thinkingLevel: string;
}

type Event = SessionEvent | MessageEvent | ModelChangeEvent | ThinkingLevelEvent;

export function Visualizer() {
	const [files, setFiles] = useState<string[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [events, setEvents] = useState<Event[]>([]);
	const [session, setSession] = useState<SessionInfo | null>(null);
	const [loadingFiles, setLoadingFiles] = useState(true);
	const [loadingSession, setLoadingSession] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [collapsedThinking, setCollapsedThinking] = useState<Set<string>>(new Set());
	const [collapsedToolResults, setCollapsedToolResults] = useState<Set<string>>(new Set());

	// Load list of session files
	useEffect(() => {
		fetch("/api/sessions")
			.then((res) => res.json())
			.then((data) => {
				if (data.success) {
					setFiles(data.files);
					// Auto-select first file if available
					if (data.files.length > 0) {
						setSelectedFile(data.files[0]);
					}
				} else {
					setError(data.error);
				}
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoadingFiles(false));
	}, []);

	// Load selected session
	useEffect(() => {
		if (!selectedFile) return;
		
		setLoadingSession(true);
		setError(null);
		
		fetch(`/api/session/${encodeURIComponent(selectedFile)}`)
			.then((res) => res.json())
			.then((data) => {
				if (data.success) {
					const sessionEvent = data.events.find((e: Event) => e.type === "session");
					if (sessionEvent) {
						setSession({
							version: sessionEvent.version,
							id: sessionEvent.id,
							timestamp: sessionEvent.timestamp,
							cwd: sessionEvent.cwd,
						});
					} else {
						setSession(null);
					}
					setEvents(data.events.filter((e: Event) => e.type !== "session"));
				} else {
					setError(data.error);
				}
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoadingSession(false));
	}, [selectedFile]);

	const loading = loadingFiles || loadingSession;

	const toggleThinking = (id: string) => {
		setCollapsedThinking((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleToolResult = (id: string) => {
		setCollapsedToolResults((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	if (loadingFiles) {
		return <div style={styles.loading}>Loading sessions...</div>;
	}

	if (error && !selectedFile) {
		return <div style={styles.error}>Error: {error}</div>;
	}

	if (files.length === 0) {
		return <div style={styles.loading}>No .jsonl files found in directory</div>;
	}

	// Build conversation view
	const conversationEvents = events.filter(
		(e) => e.type === "message" || e.type === "model_change" || e.type === "thinking_level_change"
	);

	return (
		<div style={styles.container}>
			{/* Header */}
			<header style={styles.header}>
				<div style={styles.headerTop}>
					<h1 style={styles.title}>Session Visualizer</h1>
					{files.length > 0 && (
						<select
							style={styles.fileSelect}
							value={selectedFile || ""}
							onChange={(e) => setSelectedFile(e.target.value)}
							disabled={loadingSession}
						>
							{files.map((file) => (
								<option key={file} value={file}>
									{file}
								</option>
							))}
						</select>
					)}
				</div>
				{session && (
					<div style={styles.sessionInfo}>
						<code style={styles.sessionId}>{session.id.slice(0, 8)}</code>
						<span style={styles.sessionMeta}>
							{new Date(session.timestamp).toLocaleString()}
						</span>
						<span style={styles.sessionCwd}>{session.cwd}</span>
					</div>
				)}
			</header>

			{/* Conversation */}
			<main style={styles.main}>
				{loadingSession && (
					<div style={styles.loadingOverlay}>Loading session...</div>
				)}
				{error && (
					<div style={styles.errorBanner}>Error: {error}</div>
				)}
				{conversationEvents.map((event) => {
					if (event.type === "model_change") {
						const e = event as ModelChangeEvent;
						return (
							<div key={e.id} style={styles.systemEvent}>
								🔄 Model: <strong>{e.modelId}</strong> ({e.provider})
							</div>
						);
					}

					if (event.type === "thinking_level_change") {
						const e = event as ThinkingLevelEvent;
						return (
							<div key={e.id} style={styles.systemEvent}>
								🧠 Thinking level: <strong>{e.thinkingLevel}</strong>
							</div>
						);
					}

					if (event.type === "message") {
						const e = event as MessageEvent;
						const { role, content, toolName, isError } = e.message;

						if (role === "user") {
							const textContent = content.find((c) => c.type === "text");
							return (
								<div key={e.id} style={styles.userMessage}>
									<div style={styles.roleLabel}>You</div>
									<div style={styles.messageContent}>
										{textContent?.text || "(empty)"}
									</div>
								</div>
							);
						}

						if (role === "assistant") {
							const thinking = content.find((c) => c.type === "thinking");
							const textBlocks = content.filter((c) => c.type === "text");
							const toolCalls = content.filter((c) => c.type === "toolCall");

							return (
								<div key={e.id} style={styles.assistantMessage}>
									<div style={styles.roleLabel}>
										Assistant
										{e.message.model && (
											<span style={styles.modelBadge}>{e.message.model}</span>
										)}
										{e.message.usage && (
											<span style={styles.usageBadge}>
												${e.message.usage.cost.total.toFixed(4)}
											</span>
										)}
									</div>

									{/* Thinking */}
									{thinking && (
										<div style={styles.thinkingBlock}>
											<div
												style={styles.thinkingHeader}
												onClick={() => toggleThinking(e.id)}
											>
												{collapsedThinking.has(e.id) ? "▶" : "▼"} Thinking
											</div>
											{!collapsedThinking.has(e.id) && (
												<div style={styles.thinkingContent}>
													{thinking.thinking}
												</div>
											)}
										</div>
									)}

									{/* Text content */}
									{textBlocks.map((block, i) => (
										<div
											key={i}
											className="markdown-content"
											style={styles.messageContent}
											dangerouslySetInnerHTML={{
												__html: marked(block.text || "") as string,
											}}
										/>
									))}

									{/* Tool calls */}
									{toolCalls.length > 0 && (
										<div style={styles.toolCallsContainer}>
											{toolCalls.map((tc) => (
												<div key={tc.id} style={styles.toolCall}>
													<span style={styles.toolName}>{tc.name}</span>
													<code style={styles.toolArgs}>
														{JSON.stringify(tc.arguments, null, 2)}
													</code>
												</div>
											))}
										</div>
									)}
								</div>
							);
						}

						if (role === "toolResult") {
							const textContent = content.find((c) => c.type === "text");
							const resultText = textContent?.text || "(empty)";
							const isLong = resultText.length > 500;
							const isCollapsed = collapsedToolResults.has(e.id);
							const shouldTruncate = isLong && isCollapsed;

							return (
								<div
									key={e.id}
									style={{
										...styles.toolResult,
										...(isError ? styles.toolResultError : {}),
									}}
								>
									<div style={styles.toolResultHeader}>
										<span style={styles.toolResultLabel}>
											{isError ? "❌" : "✓"} {toolName}
										</span>
										{isLong && (
											<button
												style={styles.toggleButton}
												onClick={() => toggleToolResult(e.id)}
											>
												{isCollapsed ? "Show full" : "Collapse"}
											</button>
										)}
									</div>
									<pre style={styles.toolResultContent}>
										{shouldTruncate
											? `${resultText.slice(0, 500)}...`
											: resultText}
									</pre>
								</div>
							);
						}
					}

					return null;
				})}
			</main>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		minHeight: "100vh",
		fontFamily: "system-ui, -apple-system, sans-serif",
		fontSize: "14px",
	},
	loading: {
		padding: "40px",
		textAlign: "center",
		color: "#666",
	},
	error: {
		padding: "40px",
		textAlign: "center",
		color: "#dc2626",
	},
	loadingOverlay: {
		padding: "20px",
		textAlign: "center",
		color: "#6b7280",
		fontStyle: "italic",
	},
	errorBanner: {
		padding: "12px 16px",
		backgroundColor: "#fef2f2",
		color: "#dc2626",
		borderRadius: "6px",
		border: "1px solid #fecaca",
	},
	header: {
		padding: "16px 24px",
		backgroundColor: "#1f2937",
		color: "white",
		position: "sticky",
		top: 0,
		zIndex: 100,
	},
	headerTop: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: "16px",
	},
	title: {
		margin: 0,
		fontSize: "18px",
		fontWeight: 600,
	},
	fileSelect: {
		padding: "6px 12px",
		fontSize: "13px",
		fontFamily: "ui-monospace, monospace",
		backgroundColor: "#374151",
		color: "white",
		border: "1px solid #4b5563",
		borderRadius: "4px",
		cursor: "pointer",
		maxWidth: "300px",
	},
	sessionInfo: {
		marginTop: "8px",
		display: "flex",
		gap: "12px",
		alignItems: "center",
		fontSize: "13px",
	},
	sessionId: {
		backgroundColor: "rgba(255,255,255,0.1)",
		padding: "2px 8px",
		borderRadius: "4px",
	},
	sessionMeta: {
		color: "#9ca3af",
	},
	sessionCwd: {
		color: "#9ca3af",
		fontFamily: "ui-monospace, monospace",
		fontSize: "12px",
	},
	main: {
		maxWidth: "900px",
		margin: "0 auto",
		padding: "24px",
		display: "flex",
		flexDirection: "column",
		gap: "16px",
	},
	systemEvent: {
		padding: "8px 12px",
		backgroundColor: "#fef3c7",
		borderRadius: "6px",
		fontSize: "13px",
		color: "#92400e",
	},
	userMessage: {
		padding: "16px",
		backgroundColor: "#dbeafe",
		borderRadius: "8px",
		borderLeft: "4px solid #3b82f6",
	},
	assistantMessage: {
		padding: "16px",
		backgroundColor: "white",
		borderRadius: "8px",
		border: "1px solid #e5e7eb",
	},
	roleLabel: {
		fontWeight: 600,
		fontSize: "12px",
		textTransform: "uppercase",
		color: "#6b7280",
		marginBottom: "8px",
		display: "flex",
		alignItems: "center",
		gap: "8px",
	},
	modelBadge: {
		fontSize: "11px",
		fontWeight: 400,
		padding: "2px 6px",
		backgroundColor: "#f3f4f6",
		borderRadius: "4px",
		textTransform: "none",
	},
	usageBadge: {
		fontSize: "11px",
		fontWeight: 400,
		padding: "2px 6px",
		backgroundColor: "#dcfce7",
		color: "#166534",
		borderRadius: "4px",
		textTransform: "none",
	},
	messageContent: {
		lineHeight: 1.6,
	},
	thinkingBlock: {
		marginBottom: "12px",
		backgroundColor: "#faf5ff",
		borderRadius: "6px",
		border: "1px solid #e9d5ff",
		overflow: "hidden",
	},
	thinkingHeader: {
		padding: "8px 12px",
		fontSize: "12px",
		fontWeight: 500,
		color: "#7c3aed",
		cursor: "pointer",
		userSelect: "none",
	},
	thinkingContent: {
		padding: "12px",
		paddingTop: 0,
		fontSize: "13px",
		color: "#6b7280",
		whiteSpace: "pre-wrap",
		fontFamily: "ui-monospace, monospace",
		lineHeight: 1.5,
	},
	toolCallsContainer: {
		marginTop: "12px",
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	toolCall: {
		padding: "10px 12px",
		backgroundColor: "#f8fafc",
		borderRadius: "6px",
		border: "1px solid #e2e8f0",
	},
	toolName: {
		fontWeight: 600,
		fontSize: "13px",
		color: "#0f172a",
	},
	toolArgs: {
		display: "block",
		marginTop: "6px",
		fontSize: "12px",
		color: "#64748b",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
	},
	toolResult: {
		padding: "12px",
		backgroundColor: "#f1f5f9",
		borderRadius: "6px",
		borderLeft: "3px solid #94a3b8",
		marginLeft: "20px",
	},
	toolResultError: {
		backgroundColor: "#fef2f2",
		borderLeftColor: "#ef4444",
	},
	toolResultHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: "8px",
	},
	toolResultLabel: {
		fontSize: "12px",
		fontWeight: 500,
		color: "#475569",
	},
	toggleButton: {
		fontSize: "11px",
		padding: "2px 8px",
		border: "1px solid #cbd5e1",
		borderRadius: "4px",
		backgroundColor: "white",
		cursor: "pointer",
		color: "#64748b",
	},
	toolResultContent: {
		margin: 0,
		fontSize: "12px",
		fontFamily: "ui-monospace, monospace",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		color: "#334155",
		maxHeight: "400px",
		overflow: "auto",
	},
};
