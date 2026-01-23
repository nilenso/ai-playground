import { useState, useEffect } from "react";
import { marked } from "marked";

interface ToolCallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

interface AskEntry {
	timestamp: number;
	question: string;
	toolCalls: ToolCallRecord[];
	response: string;
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

export function Visualizer() {
	const [files, setFiles] = useState<string[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [session, setSession] = useState<SessionLog | null>(null);
	const [loadingFiles, setLoadingFiles] = useState(true);
	const [loadingSession, setLoadingSession] = useState(false);
	const [error, setError] = useState<string | null>(null);

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

	if (files.length === 0) {
		return <div style={styles.loading}>No .jsonl files found in workdir/sessions</div>;
	}

	const formatTime = (ts: number) => new Date(ts).toLocaleString();
	const formatDuration = (start: number, end: number) => {
		const seconds = Math.floor((end - start) / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	};

	const endReasonLabel = (reason: string) => {
		switch (reason) {
			case "closed": return "✓ Closed";
			case "error": return "✗ Error";
			case "timeout": return "⏱ Timeout";
			default: return reason;
		}
	};

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
						<code style={styles.sessionId}>{session.sessionId.slice(0, 8)}</code>
						<span style={styles.sessionMeta}>
							{formatTime(session.startedAt)}
						</span>
						<span style={styles.sessionMeta}>
							Duration: {formatDuration(session.startedAt, session.endedAt)}
						</span>
						<span style={{
							...styles.endReasonBadge,
							backgroundColor: session.endReason === "error" ? "#fecaca" :
								session.endReason === "timeout" ? "#fef3c7" : "#d1fae5",
							color: session.endReason === "error" ? "#dc2626" :
								session.endReason === "timeout" ? "#92400e" : "#059669",
						}}>
							{endReasonLabel(session.endReason)}
						</span>
					</div>
				)}
				{session && (
					<div style={styles.repoInfo}>
						<a href={session.repo.url} target="_blank" rel="noopener noreferrer" style={styles.repoLink}>
							{session.repo.url}
						</a>
						<code style={styles.commitBadge}>{session.repo.commitish.slice(0, 8)}</code>
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
				{session?.error && (
					<div style={styles.errorBanner}>Session Error: {session.error}</div>
				)}
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

						{/* Tool Calls */}
						{ask.toolCalls.length > 0 && (
							<div style={styles.toolCallsContainer}>
								{ask.toolCalls.map((tc, tcIndex) => (
									<div key={tcIndex} style={styles.toolCall}>
										<span style={styles.toolName}>{tc.name}</span>
										<code style={styles.toolArgs}>
											{JSON.stringify(tc.arguments, null, 2)}
										</code>
									</div>
								))}
							</div>
						)}

						{/* Assistant Response */}
						<div style={styles.assistantMessage}>
							<div style={styles.roleLabel}>Assistant</div>
							<div
								className="markdown-content"
								style={styles.messageContent}
								dangerouslySetInnerHTML={{
									__html: marked(ask.response) as string,
								}}
							/>
						</div>
					</div>
				))}
				{session?.asks.length === 0 && (
					<div style={styles.emptyState}>No questions in this session</div>
				)}
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
		marginBottom: "16px",
	},
	emptyState: {
		padding: "40px",
		textAlign: "center",
		color: "#9ca3af",
		fontStyle: "italic",
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
		maxWidth: "400px",
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
	endReasonBadge: {
		padding: "2px 8px",
		borderRadius: "4px",
		fontSize: "12px",
		fontWeight: 500,
	},
	repoInfo: {
		marginTop: "8px",
		display: "flex",
		gap: "12px",
		alignItems: "center",
		fontSize: "13px",
	},
	repoLink: {
		color: "#60a5fa",
		textDecoration: "none",
	},
	commitBadge: {
		backgroundColor: "rgba(255,255,255,0.1)",
		padding: "2px 8px",
		borderRadius: "4px",
		fontSize: "12px",
	},
	main: {
		maxWidth: "900px",
		margin: "0 auto",
		padding: "24px",
		display: "flex",
		flexDirection: "column",
		gap: "24px",
	},
	askContainer: {
		display: "flex",
		flexDirection: "column",
		gap: "12px",
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
	timestamp: {
		fontWeight: 400,
		fontSize: "11px",
		color: "#9ca3af",
		textTransform: "none",
	},
	messageContent: {
		lineHeight: 1.6,
	},
	toolCallsContainer: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		marginLeft: "20px",
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
};
