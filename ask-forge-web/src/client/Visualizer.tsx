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
	firstQuestion: string;
}

function formatRepoName(url: string): string {
	return url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
	closed: { bg: "rgba(0, 212, 170, 0.1)", fg: "#00d4aa" },
	error: { bg: "rgba(239, 68, 68, 0.1)", fg: "#df1b41" },
	timeout: { bg: "rgba(234, 179, 8, 0.1)", fg: "#92400e" },
};

const STATUS_LABELS: Record<string, string> = {
	closed: "\u2713 Closed",
	error: "\u2717 Error",
	timeout: "\u23F1 Timeout",
};

export function Visualizer() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [session, setSession] = useState<SessionLog | null>(null);
	const [loadingFiles, setLoadingFiles] = useState(true);
	const [loadingSession, setLoadingSession] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedToolCalls, setExpandedToolCalls] = useState<Set<number>>(new Set());

	// Sidebar controls
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set(["closed", "error", "timeout"]));

	// Create a marked instance that links file paths to the forge
	const markedWithLinks = useMemo(
		() => createMarkedWithFileLinks(session?.repo.url, session?.repo.commitish),
		[session?.repo.url, session?.repo.commitish],
	);

	// Load list of session files
	const loadSessions = useCallback((silent = false) => {
		if (!silent) setLoadingFiles(true);
		fetch("/api/sessions")
			.then((res) => res.json())
			.then((data) => {
				if (data.success) {
					setSessions((prev) => {
						const next = data.sessions;
						if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
						return next;
					});
					setSelectedFile((current) => {
						if (!current && data.sessions.length > 0) {
							return data.sessions[0].filename;
						}
						return current;
					});
				} else if (!silent) {
					setError(data.error);
				}
			})
			.catch((err) => { if (!silent) setError(err.message); })
			.finally(() => { if (!silent) setLoadingFiles(false); });
	}, []);

	useEffect(() => {
		loadSessions();
		const interval = setInterval(() => loadSessions(true), 3000);
		return () => clearInterval(interval);
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
					setSession(data.events[0] as SessionLog);
				} else {
					setError(data.error || "No session data found");
				}
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoadingSession(false));
	}, [selectedFile]);

	// Filtered and sorted sessions
	const filteredSessions = useMemo(() => {
		const result = sessions.filter((s) => {
			if (!statusFilter.has(s.endReason)) return false;
			if (searchQuery) {
				const q = searchQuery.toLowerCase();
				const repo = formatRepoName(s.repo).toLowerCase();
				const question = s.firstQuestion.toLowerCase();
				if (!repo.includes(q) && !question.includes(q)) return false;
			}
			return true;
		});
		result.sort((a, b) => b.startedAt - a.startedAt);
		return result;
	}, [sessions, searchQuery, statusFilter]);

	const toggleStatusFilter = (status: string) => {
		setStatusFilter((prev) => {
			const next = new Set(prev);
			if (next.has(status)) {
				next.delete(status);
			} else {
				next.add(status);
			}
			return next;
		});
	};

	if (loadingFiles) {
		return <div className="viz-loading">Loading sessions...</div>;
	}

	if (error && !selectedFile) {
		return <div className="viz-error">Error: {error}</div>;
	}

	if (sessions.length === 0) {
		return <div className="viz-loading">No sessions found. Start a conversation to see it here.</div>;
	}

	const formatTime = (ts: number) => new Date(ts).toLocaleString();
	const formatShortDate = (ts: number) =>
		new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

	return (
		<div className="viz-container">
			{/* Header */}
			<header className="viz-header">
				<div className="viz-header-left">
					<h1 className="viz-title">
						<span className="viz-logo-ask">ask</span>
						<span className="viz-logo-forge">forge</span>
						<span className="viz-title-suffix"> sessions</span>
					</h1>
				</div>
			</header>

			<div className="viz-body">
				{/* Sidebar */}
				<aside className="viz-sidebar">
					<div className="viz-sidebar-controls">
						{/* Search */}
						<input
							type="text"
							className="viz-search"
							placeholder="Search by repo or name..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
						/>

						{/* Status filter */}
						<div className="viz-filter-row">
							{(["closed", "error", "timeout"] as const).map((status) => (
								<label key={status} className="viz-filter-label">
									<input
										type="checkbox"
										checked={statusFilter.has(status)}
										onChange={() => toggleStatusFilter(status)}
									/>
									<span
										className="viz-filter-badge"
										style={{
											backgroundColor: STATUS_COLORS[status]?.bg,
											color: STATUS_COLORS[status]?.fg,
										}}
									>
										{STATUS_LABELS[status]}
									</span>
								</label>
							))}
						</div>
					</div>

					{/* Session list */}
					<div className="viz-session-list">
						{filteredSessions.length === 0 && <div className="viz-no-results">No matching sessions</div>}
						{filteredSessions.map((s) => (
							<button
								key={s.filename}
								type="button"
								className={`viz-session-card ${selectedFile === s.filename ? "selected" : ""}`}
								onClick={() => setSelectedFile(s.filename)}
							>
								<div className="viz-card-repo">
									{s.firstQuestion || (s.repo !== "unknown" ? formatRepoName(s.repo) : s.filename.slice(0, 12))}
								</div>
								<div className="viz-card-meta">
									<span>{s.startedAt ? formatShortDate(s.startedAt) : "—"}</span>
									<span className="viz-card-questions">{s.askCount}q</span>
									<span
										className="viz-card-status"
										style={{
											backgroundColor: STATUS_COLORS[s.endReason]?.bg ?? "#f3f4f6",
											color: STATUS_COLORS[s.endReason]?.fg ?? "#8898aa",
										}}
									>
										{STATUS_LABELS[s.endReason] ?? s.endReason}
									</span>
								</div>
							</button>
						))}
					</div>
				</aside>

				{/* Main content */}
				<div className="viz-main">
					{session && (
						<div className="viz-session-bar">
							<span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{formatRepoName(session.repo.url)}</span>
							<code className="viz-commit-badge">{session.repo.commitish.slice(0, 8)}</code>
							<span className="viz-session-meta">{formatTime(session.startedAt)}</span>
							<span className="viz-session-meta">Duration: {formatDuration(session.startedAt, session.endedAt)}</span>
							<span
								className="viz-end-badge"
								style={{
									backgroundColor: STATUS_COLORS[session.endReason]?.bg,
									color: STATUS_COLORS[session.endReason]?.fg,
								}}
							>
								{STATUS_LABELS[session.endReason] ?? session.endReason}
							</span>
						</div>
					)}

					<div className="viz-conversation">
						{loadingSession && <div className="viz-loading-overlay">Loading session...</div>}
						{error && <div className="viz-error-banner">Error: {error}</div>}
						{session?.error && <div className="viz-error-banner">Session Error: {session.error}</div>}
						{session?.asks.map((ask, index) => (
							<div key={index} className="viz-ask-container">
								{/* User Question */}
								<div className="viz-user-msg">
									<div className="viz-role-label">
										You
										<span className="viz-timestamp">{formatTime(ask.timestamp)}</span>
									</div>
									<div className="viz-msg-content">{ask.question}</div>
								</div>

								{/* Tool Calls - Collapsible */}
								{ask.toolCalls.length > 0 && (
									<div className="viz-tool-calls">
										<button type="button" className="viz-tool-header" onClick={() => toggleToolCalls(index)}>
											<span className="viz-tool-toggle">{expandedToolCalls.has(index) ? "\u25BC" : "\u25B6"}</span>
											<span className="viz-tool-count">
												{ask.toolCalls.length} tool call{ask.toolCalls.length !== 1 ? "s" : ""}
											</span>
										</button>
										{expandedToolCalls.has(index) && (
											<div className="viz-tool-list">
												{ask.toolCalls.map((tc, tcIndex) => (
													<div key={`${index}-${tcIndex}`} className="viz-tool-item">
														<span className="viz-tool-name">{tc.name}</span>
														<code className="viz-tool-args">{JSON.stringify(tc.arguments, null, 2)}</code>
													</div>
												))}
											</div>
										)}
									</div>
								)}

								{/* Assistant Response */}
								<div className="viz-assistant-msg">
									<div className="viz-role-label">
										Assistant
										{(ask.usage || ask.inferenceTimeMs !== undefined) && (
											<span className="viz-metrics">
												{ask.usage && <>{formatTokens(ask.usage.totalTokens)} tokens</>}
												{ask.usage && ask.inferenceTimeMs !== undefined && " \u00B7 "}
												{ask.inferenceTimeMs !== undefined && formatInferenceTime(ask.inferenceTimeMs)}
											</span>
										)}
									</div>
									<div
										className="markdown-content"
										dangerouslySetInnerHTML={{
											__html: markedWithLinks.parse(ask.response) as string,
										}}
									/>
									<div className="viz-msg-actions">
										<span className={ask.feedback === "like" ? "viz-action-active" : "viz-action"} title="Thumbs up">
											<svg
												xmlns="http://www.w3.org/2000/svg"
												fill="none"
												viewBox="0 0 24 24"
												strokeWidth={1.5}
												stroke="currentColor"
												width={16}
												height={16}
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
										</span>
										<span
											className={ask.feedback === "dislike" ? "viz-action-active" : "viz-action"}
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
										</span>
									</div>
								</div>
							</div>
						))}
						{session?.asks.length === 0 && <div className="viz-empty">No questions in this session</div>}
					</div>
				</div>
			</div>
		</div>
	);
}
