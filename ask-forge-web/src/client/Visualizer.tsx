import hljs from "highlight.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createMarkedWithFileLinks } from "./file-linker.ts";

interface ToolCallRecord {
	type: string;
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
}

interface Annotation {
	isRelevant: boolean | null;
	isEvidenceSupported: boolean | null;
	isClear: boolean | null;
	feedbackText: string | null;
}

interface AskEntry {
	timestamp: number;
	question: string;
	toolCalls: ToolCallRecord[];
	response: string;
	// Optional fields for backwards compatibility
	usage?: {
		input: number;
		output: number;
		totalTokens: number;
		cacheRead: number;
		cacheWrite: number;
	};
	inferenceTimeMs?: number;
	feedback?: "like" | "dislike";
	annotation?: Annotation;
}

interface SessionLog {
	sessionId: string;
	repo: { url: string; commitish: string };
	startedAt: number;
	endedAt: number;
	endReason: "active" | "inactive" | "error";
	error?: string;
	asks: AskEntry[];
}

interface SessionSummary {
	id: string;
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
	active: { bg: "rgba(59, 130, 246, 0.1)", fg: "#3b82f6" },
	inactive: { bg: "rgba(0, 212, 170, 0.1)", fg: "#00d4aa" },
	error: { bg: "rgba(239, 68, 68, 0.1)", fg: "#df1b41" },
};

const STATUS_LABELS: Record<string, string> = {
	active: "\u25CF Active",
	inactive: "\u2713 Inactive",
	error: "\u2717 Error",
};

// Format tool arguments for inline display
function formatToolArgs(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	return entries
		.map(([key, value]) => {
			const strValue = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
			// Truncate long values
			const displayValue = strValue.length > 50 ? `${strValue.slice(0, 47)}...` : strValue;
			return `${key}: ${displayValue}`;
		})
		.join(", ");
}

// Try to detect and highlight tool results appropriately
function highlightToolResult(result: string): string {
	const trimmed = result.trim();

	// Try JSON first
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			JSON.parse(trimmed);
			return hljs.highlight(trimmed, { language: "json" }).value;
		} catch {
			// Not valid JSON, continue
		}
	}

	// For other content, use auto-detection or plain text
	// hljs.highlightAuto can be slow on large content, so limit it
	if (trimmed.length < 10000) {
		const detected = hljs.highlightAuto(trimmed, ["bash", "json", "xml", "markdown", "plaintext"]);
		return detected.value;
	}

	// For very large content, just escape and return
	return trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Annotation questions
const ANNOTATION_QUESTIONS = {
	isRelevant: "Is the response relevant to the question?",
	isEvidenceSupported: "Are the claims supported by evidence?",
	isClear: "Is the response clear and readable?",
};

export function Visualizer() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [session, setSession] = useState<SessionLog | null>(null);
	const [loadingFiles, setLoadingFiles] = useState(true);
	const [loadingSession, setLoadingSession] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());

	// Sidebar controls
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set(["active", "inactive", "error"]));

	// Annotation state
	const [openAnnotationIndex, setOpenAnnotationIndex] = useState<number | null>(null);
	const [annotationDrafts, setAnnotationDrafts] = useState<Map<number, Annotation>>(new Map());
	const [savingAnnotation, setSavingAnnotation] = useState<number | null>(null);
	const [savedAnnotation, setSavedAnnotation] = useState<number | null>(null);

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
					setSelectedId((current) => {
						if (!current && data.sessions.length > 0) {
							return data.sessions[0].id;
						}
						return current;
					});
				} else if (!silent) {
					setError(data.error);
				}
			})
			.catch((err) => {
				if (!silent) setError(err.message);
			})
			.finally(() => {
				if (!silent) setLoadingFiles(false);
			});
	}, []);

	useEffect(() => {
		loadSessions();
		const interval = setInterval(() => loadSessions(true), 3000);
		return () => clearInterval(interval);
	}, [loadSessions]);

	// Load selected session
	useEffect(() => {
		if (!selectedId) return;

		setLoadingSession(true);
		setError(null);

		fetch(`/api/session/${encodeURIComponent(selectedId)}`)
			.then((res) => res.json())
			.then((data) => {
				if (data.success && data.session) {
					setSession(data.session as SessionLog);
				} else {
					setError(data.error || "No session data found");
				}
			})
			.catch((err) => setError(err.message))
			.finally(() => setLoadingSession(false));
	}, [selectedId]);

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

	if (error && !selectedId) {
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

	const toggleToolCalls = (key: string) => {
		setExpandedToolCalls((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	// Get annotation for an ask (from draft or session data)
	const getAnnotation = (askIndex: number): Annotation => {
		const draft = annotationDrafts.get(askIndex);
		if (draft) return draft;
		const saved = session?.asks[askIndex]?.annotation;
		return saved ?? { isRelevant: null, isEvidenceSupported: null, isClear: null, feedbackText: null };
	};

	// Check if an ask has any annotation data
	const hasAnnotation = (askIndex: number): boolean => {
		const ann = getAnnotation(askIndex);
		return ann.isRelevant !== null || ann.isEvidenceSupported !== null || ann.isClear !== null || !!ann.feedbackText;
	};

	// Update annotation draft
	const updateAnnotationDraft = (askIndex: number, updates: Partial<Annotation>) => {
		setAnnotationDrafts((prev) => {
			const next = new Map(prev);
			const current = getAnnotation(askIndex);
			next.set(askIndex, { ...current, ...updates });
			return next;
		});
	};

	// Save annotation to server
	const saveAnnotation = async (askIndex: number) => {
		if (!selectedId) return;
		const annotation = getAnnotation(askIndex);
		setSavingAnnotation(askIndex);
		setSavedAnnotation(null);
		try {
			const res = await fetch(`/api/session/${encodeURIComponent(selectedId)}/annotation/${askIndex}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(annotation),
			});
			const data = await res.json();
			if (data.success) {
				// Update session with saved annotation
				setSession((prev) => {
					if (!prev) return prev;
					const asks = [...prev.asks];
					asks[askIndex] = { ...asks[askIndex], annotation: data.annotation };
					return { ...prev, asks };
				});
				// Clear draft
				setAnnotationDrafts((prev) => {
					const next = new Map(prev);
					next.delete(askIndex);
					return next;
				});
				setSavedAnnotation(askIndex);
				setTimeout(() => setSavedAnnotation(null), 2000);
			}
		} catch (err) {
			console.error("Failed to save annotation:", err);
		} finally {
			setSavingAnnotation(null);
		}
	};

	// Toggle annotation panel
	const toggleAnnotation = (askIndex: number) => {
		setOpenAnnotationIndex((prev) => (prev === askIndex ? null : askIndex));
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
							{(["active", "inactive", "error"] as const).map((status) => (
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
								key={s.id}
								type="button"
								className={`viz-session-card ${selectedId === s.id ? "selected" : ""}`}
								onClick={() => setSelectedId(s.id)}
							>
								<div className="viz-card-repo">
									{s.firstQuestion || (s.repo !== "unknown" ? formatRepoName(s.repo) : s.id.slice(0, 12))}
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

								{/* Tool Calls - Each individually collapsible */}
								{ask.toolCalls.length > 0 && (
									<div className="viz-tool-calls">
										<div className="viz-tool-list">
											{ask.toolCalls.map((tc, tcIndex) => {
												const toolKey = `${index}-${tcIndex}`;
												const isExpanded = expandedToolCalls.has(toolKey);
												const hasResult = tc.result !== undefined;
												return (
													<div key={toolKey} className="viz-tool-item">
														<button
															type="button"
															className={`viz-tool-item-header ${hasResult ? "has-result" : ""}`}
															onClick={() => hasResult && toggleToolCalls(toolKey)}
															disabled={!hasResult}
														>
															<span className="viz-tool-toggle">
																{hasResult ? (isExpanded ? "\u25BC" : "\u25B6") : "\u2022"}
															</span>
															<span className="viz-tool-name">{tc.name}</span>
															<span className="viz-tool-args-inline">{formatToolArgs(tc.arguments)}</span>
														</button>
														{isExpanded && hasResult && (
															<div className="viz-tool-details">
																<div className="viz-tool-section-label">Response</div>
																<pre
																	className="viz-tool-code viz-tool-result hljs"
																	dangerouslySetInnerHTML={{
																		__html: highlightToolResult(tc.result),
																	}}
																/>
															</div>
														)}
													</div>
												);
											})}
										</div>
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
									{ask.response.startsWith("[ERROR:") ? (
										<div className="viz-error-banner">
											{ask.response.replace(/^\[ERROR:\s*/, "").replace(/\]$/, "")}
										</div>
									) : (
										<div
											className="markdown-content"
											dangerouslySetInnerHTML={{
												__html: markedWithLinks.parse(ask.response) as string,
											}}
										/>
									)}
									<div className="viz-msg-actions">
										<button
											type="button"
											className={`viz-action-btn ${hasAnnotation(index) ? "has-annotation" : ""}`}
											onClick={() => toggleAnnotation(index)}
											title="Add annotation"
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
												aria-label="Annotate"
											>
												<title>Annotate</title>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
												/>
											</svg>
										</button>
									</div>

									{/* Annotation Box */}
									{openAnnotationIndex === index && (
										<div className="viz-annotation-box">
											<div className="viz-annotation-header">
												<span className="viz-annotation-title">📝 Annotation</span>
												<button
													type="button"
													className="viz-annotation-close"
													onClick={() => setOpenAnnotationIndex(null)}
												>
													×
												</button>
											</div>
											<div className="viz-annotation-content">
												{/* Question 1: Relevant */}
												<div className="viz-annotation-question">
													<span className="viz-annotation-question-text">{ANNOTATION_QUESTIONS.isRelevant}</span>
													<div className="viz-annotation-buttons">
														<button
															type="button"
															className={`viz-yes-no-btn ${getAnnotation(index).isRelevant === true ? "selected" : ""}`}
															onClick={() => updateAnnotationDraft(index, { isRelevant: true })}
														>
															Yes
														</button>
														<button
															type="button"
															className={`viz-yes-no-btn ${getAnnotation(index).isRelevant === false ? "selected" : ""}`}
															onClick={() => updateAnnotationDraft(index, { isRelevant: false })}
														>
															No
														</button>
													</div>
												</div>

												{/* Question 2: Evidence */}
												<div className="viz-annotation-question">
													<span className="viz-annotation-question-text">
														{ANNOTATION_QUESTIONS.isEvidenceSupported}
													</span>
													<div className="viz-annotation-buttons">
														<button
															type="button"
															className={`viz-yes-no-btn ${getAnnotation(index).isEvidenceSupported === true ? "selected" : ""}`}
															onClick={() => updateAnnotationDraft(index, { isEvidenceSupported: true })}
														>
															Yes
														</button>
														<button
															type="button"
															className={`viz-yes-no-btn ${getAnnotation(index).isEvidenceSupported === false ? "selected" : ""}`}
															onClick={() => updateAnnotationDraft(index, { isEvidenceSupported: false })}
														>
															No
														</button>
													</div>
												</div>

												{/* Question 3: Clear */}
												<div className="viz-annotation-question">
													<span className="viz-annotation-question-text">{ANNOTATION_QUESTIONS.isClear}</span>
													<div className="viz-annotation-buttons">
														<button
															type="button"
															className={`viz-yes-no-btn ${getAnnotation(index).isClear === true ? "selected" : ""}`}
															onClick={() => updateAnnotationDraft(index, { isClear: true })}
														>
															Yes
														</button>
														<button
															type="button"
															className={`viz-yes-no-btn ${getAnnotation(index).isClear === false ? "selected" : ""}`}
															onClick={() => updateAnnotationDraft(index, { isClear: false })}
														>
															No
														</button>
													</div>
												</div>

												{/* Feedback text */}
												<div className="viz-annotation-feedback">
													<label className="viz-annotation-feedback-label">Additional feedback</label>
													<textarea
														className="viz-annotation-textarea"
														placeholder="Add your notes here..."
														value={getAnnotation(index).feedbackText || ""}
														onChange={(e) => updateAnnotationDraft(index, { feedbackText: e.target.value })}
													/>
												</div>

												{/* Save button */}
												<div className="viz-annotation-footer">
													<button
														type="button"
														className="viz-annotation-save-btn"
														onClick={() => saveAnnotation(index)}
														disabled={savingAnnotation === index}
													>
														{savingAnnotation === index ? "Saving..." : savedAnnotation === index ? "Saved ✓" : "Save"}
													</button>
												</div>
											</div>
										</div>
									)}
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
