import { useCallback, useEffect, useMemo, useState } from "react";
import { createMarkedWithFileLinks } from "./file-linker.ts";

interface ToolCallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

interface AskEntry {
	timestamp: number;
	question: string;
	toolCalls: ToolCallRecord[];
	response: string;
	// Optional fields for backwards compatibility
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	inferenceTimeMs?: number;
	feedback?: "like" | "dislike";
}

interface SessionLog {
	sessionId: string;
	repo: { url: string; commitish: string };
	startedAt: number;
	endedAt: number;
	endReason: "closed" | "error" | "timeout";
	error?: string;
	asks: AskEntry[];
}

interface SessionSummary {
	filename: string;
	repo: string;
	startedAt: number;
	endReason: string;
	askCount: number;
}

function formatRepoName(url: string): string {
	return url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
}

function formatSessionLabel(s: SessionSummary): string {
	const repo = s.repo !== "unknown" ? formatRepoName(s.repo) : s.filename;
	const date = s.startedAt
		? new Date(s.startedAt).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: "";
	const status =
		s.endReason === "closed"
			? "\u2713"
			: s.endReason === "error"
				? "\u2717"
				: s.endReason === "timeout"
					? "\u23F1"
					: "";
	return `${status} ${repo}${date ? ` \u2014 ${date}` : ""} (${s.askCount}q)`;
}

export function Visualizer() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [session, setSession] = useState<SessionLog | null>(null);
	const [loadingFiles, setLoadingFiles] = useState(true);
	const [loadingSession, setLoadingSession] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedToolCalls, setExpandedToolCalls] = useState<Set<number>>(new Set());

	// Create a marked instance that links file paths to the forge
	const markedWithLinks = useMemo(
		() => createMarkedWithFileLinks(session?.repo.url, session?.repo.commitish),
		[session?.repo.url, session?.repo.commitish],
	);

	// Load list of session files
	const loadSessions = useCallback(() => {
		setLoadingFiles(true);
		fetch("/api/sessions")
			.then((res) => res.json())
			.then((data) => {
				if (data.success) {
					setSessions(data.sessions);
					// Auto-select first file if available and none selected
					setSelectedFile((current) => {
						if (!current && data.sessions.length > 0) {
							return data.sessions[0].filename;
						}
						return current;
					});
				} else {
					setError(data.error);
				}
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoadingFiles(false));
	}, []);

	useEffect(() => {
		loadSessions();
	}, [loadSessions]);

	// Load selected session
	useEffect(() => {
		if (!selectedFile) return;

		setLoadingSession(true);
		setError(null);

		fetch(`/api/session/${encodeURIComponent(selectedFile)}`)
			.then((res) => res.json())
			.then((data) => {
				if (data.success && data.events.length > 0) {
					// Our format: single JSON object per session
					setSession(data.events[0] as SessionLog);
				} else {
					setError(data.error || "No session data found");
				}
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoadingSession(false));
	}, [selectedFile]);

	if (loadingFiles) {
		return <div style={styles.loading}>Loading sessions...</div>;
	}

	if (error && !selectedFile) {
		return <div style={styles.error}>Error: {error}</div>;
	}

	if (sessions.length === 0) {
		return <div style={styles.loading}>No sessions found. Start a conversation to see it here.</div>;
	}

	const formatTime = (ts: number) => new Date(ts).toLocaleString();
	const formatDuration = (start: number, end: number) => {
		const seconds = Math.floor((end - start) / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	};

	const formatTokens = (tokens: number) => {
		if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
		return tokens.toString();
	};

	const formatInferenceTime = (ms: number) => {
		if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
		return `${ms}ms`;
	};

	const toggleToolCalls = (index: number) => {
		setExpandedToolCalls((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	};

	const endReasonLabel = (reason: string) => {
		switch (reason) {
			case "closed":
				return "✓ Closed";
			case "error":
				return "✗ Error";
			case "timeout":
				return "⏱ Timeout";
			default:
				return reason;
		}
	};

	return (
		<div style={styles.container}>
			{/* Header */}
			<header style={styles.header}>
				<div style={styles.headerLeft}>
					<h1 style={styles.title}>
						<span style={styles.logoAsk}>ask</span>
						<span style={styles.logoForge}>forge</span>
						<span style={styles.titleSuffix}> sessions</span>
					</h1>
					{session && (
						<div style={styles.repoStatusInline}>
							<span style={styles.statusIndicator} />
							<a href={session.repo.url} target="_blank" rel="noopener noreferrer" style={styles.repoLink}>
								{session.repo.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
							</a>
							<code style={styles.commitBadge}>{session.repo.commitish.slice(0, 8)}</code>
						</div>
					)}
				</div>
				<div style={styles.headerRight}>
					{sessions.length > 0 && (
						<select
							style={styles.fileSelect}
							value={selectedFile || ""}
							onChange={(e) => setSelectedFile(e.target.value)}
							disabled={loadingSession}
						>
							{sessions.map((s) => (
								<option key={s.filename} value={s.filename}>
									{formatSessionLabel(s)}
								</option>
							))}
						</select>
					)}
					<button
						type="button"
						style={styles.refreshButton}
						onClick={loadSessions}
						disabled={loadingFiles}
						title="Refresh session list"
					>
						&#x21BB;
					</button>
				</div>
			</header>
			{session && (
				<div style={styles.sessionBar}>
					<code style={styles.sessionId}>{session.sessionId.slice(0, 8)}</code>
					<span style={styles.sessionMeta}>{formatTime(session.startedAt)}</span>
					<span style={styles.sessionMeta}>Duration: {formatDuration(session.startedAt, session.endedAt)}</span>
					<span
						style={{
							...styles.endReasonBadge,
							backgroundColor:
								session.endReason === "error"
									? "rgba(239, 68, 68, 0.1)"
									: session.endReason === "timeout"
										? "rgba(234, 179, 8, 0.1)"
										: "rgba(0, 212, 170, 0.1)",
							color:
								session.endReason === "error" ? "#df1b41" : session.endReason === "timeout" ? "#92400e" : "#00d4aa",
						}}
					>
						{endReasonLabel(session.endReason)}
					</span>
				</div>
			)}

			{/* Conversation */}
			<main style={styles.main}>
				{loadingSession && <div style={styles.loadingOverlay}>Loading session...</div>}
				{error && <div style={styles.errorBanner}>Error: {error}</div>}
				{session?.error && <div style={styles.errorBanner}>Session Error: {session.error}</div>}
				{session?.asks.map((ask, index) => (
					<div key={index} style={styles.askContainer}>
						{/* User Question */}
						<div style={styles.userMessage}>
							<div style={styles.roleLabel}>
								You
								<span style={styles.timestamp}>{formatTime(ask.timestamp)}</span>
							</div>
							<div style={styles.messageContent}>{ask.question}</div>
						</div>

						{/* Tool Calls - Collapsible */}
						{ask.toolCalls.length > 0 && (
							<div style={styles.toolCallsContainer}>
								<div style={styles.toolCallsHeader} onClick={() => toggleToolCalls(index)}>
									<span style={styles.toolCallsToggle}>{expandedToolCalls.has(index) ? "▼" : "▶"}</span>
									<span style={styles.toolCallsCount}>
										{ask.toolCalls.length} tool call{ask.toolCalls.length !== 1 ? "s" : ""}
									</span>
								</div>
								{expandedToolCalls.has(index) && (
									<div style={styles.toolCallsList}>
										{ask.toolCalls.map((tc, tcIndex) => (
											<div key={`${index}-${tcIndex}`} style={styles.toolCall}>
												<span style={styles.toolName}>{tc.name}</span>
												<code style={styles.toolArgs}>{JSON.stringify(tc.arguments, null, 2)}</code>
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{/* Assistant Response */}
						<div style={styles.assistantMessage}>
							<div style={styles.roleLabel}>
								Assistant
								{(ask.usage || ask.inferenceTimeMs !== undefined) && (
									<span style={styles.metrics}>
										{ask.usage && <>{formatTokens(ask.usage.totalTokens)} tokens</>}
										{ask.usage && ask.inferenceTimeMs !== undefined && " · "}
										{ask.inferenceTimeMs !== undefined && formatInferenceTime(ask.inferenceTimeMs)}
									</span>
								)}
							</div>
							<div
								className="markdown-content"
								style={styles.messageContent}
								dangerouslySetInnerHTML={{
									__html: markedWithLinks.parse(ask.response) as string,
								}}
							/>
							<div style={styles.messageActions}>
								<span style={ask.feedback === "like" ? styles.actionIconActive : styles.actionIcon} title="Thumbs up">
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										strokeWidth={1.5}
										stroke="currentColor"
										width={16}
										height={16}
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											d="M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75a.75.75 0 0 1 .75-.75 2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 0 1-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 0 0-1.423-.23H3.75"
										/>
									</svg>
								</span>
								<span
									style={ask.feedback === "dislike" ? styles.actionIconActive : styles.actionIcon}
									title="Thumbs down"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										strokeWidth={1.5}
										stroke="currentColor"
										width={16}
										height={16}
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											d="M17.367 13.75c-.806 0-1.533.446-2.031 1.08a9.041 9.041 0 0 1-2.861 2.4c-.723.384-1.35.956-1.653 1.715a4.498 4.498 0 0 0-.322 1.672v.633a.75.75 0 0 1-.75.75 2.25 2.25 0 0 1-2.25-2.25c0-1.152.26-2.243.723-3.218.266-.558-.107-1.282-.725-1.282m0 0H4.372c-1.026 0-1.945-.694-2.054-1.715A12.134 12.134 0 0 1 2.25 12c0-2.848.992-5.464 2.649-7.521C5.287 3.997 5.886 3.75 6.504 3.75h4.016c.483 0 .964.078 1.423.23l3.114 1.04a4.501 4.501 0 0 0 1.423.23h2.27"
										/>
									</svg>
								</span>
							</div>
						</div>
					</div>
				))}
				{session?.asks.length === 0 && <div style={styles.emptyState}>No questions in this session</div>}
			</main>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		minHeight: "100vh",
		display: "flex",
		flexDirection: "column",
	},
	loading: {
		padding: "40px",
		textAlign: "center",
		color: "#8898aa",
	},
	error: {
		padding: "40px",
		textAlign: "center",
		color: "#df1b41",
	},
	loadingOverlay: {
		padding: "20px",
		textAlign: "center",
		color: "#425466",
		fontStyle: "italic",
	},
	errorBanner: {
		padding: "12px 16px",
		backgroundColor: "rgba(239, 68, 68, 0.1)",
		color: "#df1b41",
		borderRadius: "8px",
		border: "1px solid rgba(239, 68, 68, 0.2)",
		marginBottom: "16px",
		fontSize: "14px",
	},
	emptyState: {
		padding: "40px",
		textAlign: "center",
		color: "#8898aa",
		fontStyle: "italic",
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "16px 24px",
		borderBottom: "1px solid #e5e7eb",
		backgroundColor: "#ffffff",
		flexShrink: 0,
		position: "sticky",
		top: 0,
		zIndex: 100,
	},
	headerLeft: {
		display: "flex",
		alignItems: "center",
		gap: "16px",
	},
	headerRight: {
		display: "flex",
		alignItems: "center",
		gap: "12px",
	},
	title: {
		margin: 0,
		fontSize: "20px",
		fontWeight: 700,
		letterSpacing: "-0.02em",
	},
	logoAsk: {
		color: "#8898aa",
	},
	logoForge: {
		color: "#ec4899",
	},
	titleSuffix: {
		color: "#8898aa",
		fontWeight: 500,
		fontSize: "16px",
	},
	repoStatusInline: {
		display: "flex",
		alignItems: "center",
		gap: "10px",
	},
	statusIndicator: {
		width: "8px",
		height: "8px",
		borderRadius: "50%",
		backgroundColor: "#00d4aa",
		boxShadow: "0 0 8px rgba(0, 212, 170, 0.4)",
	},
	fileSelect: {
		padding: "8px 16px",
		fontSize: "14px",
		fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
		backgroundColor: "#ffffff",
		color: "#0a2540",
		border: "1px solid #e5e7eb",
		borderRadius: "8px",
		cursor: "pointer",
		maxWidth: "400px",
		boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
	},
	sessionBar: {
		display: "flex",
		gap: "12px",
		alignItems: "center",
		fontSize: "13px",
		padding: "10px 24px",
		backgroundColor: "#f9fafb",
		borderBottom: "1px solid #e5e7eb",
	},
	sessionId: {
		backgroundColor: "#f3f4f6",
		padding: "4px 8px",
		borderRadius: "4px",
		fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
		fontSize: "12px",
		color: "#425466",
	},
	sessionMeta: {
		color: "#8898aa",
	},
	endReasonBadge: {
		padding: "4px 8px",
		borderRadius: "4px",
		fontSize: "12px",
		fontWeight: 500,
	},
	repoLink: {
		color: "#ec4899",
		textDecoration: "none",
		fontWeight: 500,
	},
	commitBadge: {
		backgroundColor: "#f3f4f6",
		padding: "4px 8px",
		borderRadius: "4px",
		fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
		fontSize: "12px",
		color: "#425466",
	},
	main: {
		flex: 1,
		overflowY: "auto",
		padding: "24px",
		display: "flex",
		flexDirection: "column",
		gap: "24px",
	},
	askContainer: {
		maxWidth: "800px",
		width: "100%",
		margin: "0 auto",
		display: "flex",
		flexDirection: "column",
		gap: "12px",
	},
	userMessage: {
		padding: "16px 20px",
		backgroundColor: "#f3f4f6",
		borderRadius: "12px",
		border: "1px solid #e5e7eb",
	},
	assistantMessage: {
		padding: "16px 20px",
	},
	roleLabel: {
		fontWeight: 600,
		fontSize: "12px",
		textTransform: "uppercase",
		letterSpacing: "0.05em",
		color: "#8898aa",
		marginBottom: "8px",
		display: "flex",
		alignItems: "center",
		gap: "8px",
	},
	timestamp: {
		fontWeight: 400,
		fontSize: "11px",
		color: "#8898aa",
		textTransform: "none",
		letterSpacing: "normal",
	},
	messageContent: {
		lineHeight: 1.7,
		color: "#0a2540",
	},
	toolCallsContainer: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		marginLeft: "20px",
	},
	toolCall: {
		padding: "8px 12px",
		backgroundColor: "#f3f4f6",
		borderRadius: "6px",
		fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
		fontSize: "12px",
	},
	toolName: {
		fontWeight: 600,
		fontSize: "13px",
		color: "#7c3aed",
	},
	toolArgs: {
		display: "block",
		marginTop: "6px",
		fontSize: "12px",
		color: "#8898aa",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
	},
	toolCallsHeader: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		padding: "8px 12px",
		backgroundColor: "#f3f4f6",
		borderRadius: "6px",
		cursor: "pointer",
		userSelect: "none" as const,
		fontSize: "13px",
		color: "#8898aa",
	},
	toolCallsToggle: {
		fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
		fontSize: "12px",
		color: "#8898aa",
	},
	toolCallsCount: {
		fontSize: "13px",
		color: "#425466",
		fontWeight: 500,
	},
	toolCallsList: {
		display: "flex",
		flexDirection: "column" as const,
		gap: "8px",
		marginTop: "8px",
	},
	metrics: {
		fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
		fontSize: "11px",
		color: "#8898aa",
		fontWeight: 400,
		marginLeft: "auto",
	},
	messageActions: {
		display: "flex",
		alignItems: "center",
		gap: "2px",
		justifyContent: "flex-end",
		marginTop: "8px",
	},
	actionIcon: {
		display: "inline-flex",
		padding: "4px 6px",
		color: "#8898aa",
	},
	actionIconActive: {
		display: "inline-flex",
		padding: "4px 6px",
		color: "#ec4899",
	},
	refreshButton: {
		padding: "8px 12px",
		fontSize: "16px",
		backgroundColor: "#ffffff",
		color: "#425466",
		border: "1px solid #e5e7eb",
		borderRadius: "8px",
		cursor: "pointer",
		boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
		lineHeight: 1,
	},
};
