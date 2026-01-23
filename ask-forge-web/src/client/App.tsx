import { useState, useCallback, useEffect, useRef } from "react";
import { marked } from "marked";

type ValidationState = "idle" | "validating" | "valid" | "invalid";
type ConnectionState = "idle" | "connecting" | "connected" | "error";

interface ConnectionResult {
	normalized: string;
	localPath: string;
	commitish: string;
	summary: string;
}

// Cookie helpers
function setCookie(name: string, value: string, days = 365) {
	const expires = new Date(Date.now() + days * 864e5).toUTCString();
	document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function getCookie(name: string): string | null {
	const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
	return match ? decodeURIComponent(match[2]) : null;
}

export function App() {
	const [url, setUrl] = useState("");
	const [commit, setCommit] = useState("");
	const [validationState, setValidationState] = useState<ValidationState>("idle");
	const [validationError, setValidationError] = useState<string | null>(null);
	const [normalizedUrl, setNormalizedUrl] = useState<string | null>(null);

	const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);

	const urlInputRef = useRef<HTMLInputElement>(null);

	const validateAndConnect = useCallback(async (inputUrl: string, inputCommit: string) => {
		if (!inputUrl.trim()) {
			setValidationState("idle");
			setValidationError(null);
			return;
		}

		// Step 1: Validate
		setValidationState("validating");
		setValidationError(null);
		setConnectionState("idle");
		setConnectionResult(null);

		try {
			const validateRes = await fetch("/api/validate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: inputUrl }),
			});

			const validateData = await validateRes.json();

			if (!validateData.valid) {
				setValidationState("invalid");
				setValidationError(validateData.error || "Invalid repository URL");
				return;
			}

			setValidationState("valid");
			setNormalizedUrl(validateData.normalized);

			// Step 2: Connect and ask
			setConnectionState("connecting");

			const connectRes = await fetch("/api/connect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ 
					url: inputUrl,
					commit: inputCommit.trim() || undefined 
				}),
			});

			const connectData = await connectRes.json();

			if (!connectData.success) {
				setConnectionState("error");
				setConnectionError(connectData.error || "Failed to connect to repository");
				return;
			}

			setConnectionState("connected");
			setConnectionResult({
				normalized: connectData.normalized,
				localPath: connectData.localPath,
				commitish: connectData.commitish,
				summary: connectData.summary,
			});

			// Save to cookies on successful connection
			setCookie("askforge_repo_url", inputUrl);
			setCookie("askforge_repo_commit", inputCommit.trim());
		} catch (err) {
			setValidationState("invalid");
			setValidationError(err instanceof Error ? err.message : "Network error");
		}
	}, []);

	const handleBlur = useCallback(() => {
		validateAndConnect(url, commit);
	}, [url, commit, validateAndConnect]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				validateAndConnect(url, commit);
			}
		},
		[url, commit, validateAndConnect]
	);

	// Load saved repository from cookie on mount
	useEffect(() => {
		const savedUrl = getCookie("askforge_repo_url");
		const savedCommit = getCookie("askforge_repo_commit");
		
		if (savedUrl) {
			setUrl(savedUrl);
			if (savedCommit) {
				setCommit(savedCommit);
			}
			// Auto-connect to saved repository
			validateAndConnect(savedUrl, savedCommit || "");
		} else {
			// No saved repo, focus the input
			urlInputRef.current?.focus();
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // Run only on mount

	return (
		<div style={styles.container}>
			<div style={styles.card}>
				<h1 style={styles.title}>Ask Forge</h1>
				<p style={styles.subtitle}>Ask questions about any git repository</p>

				<div style={styles.inputGroup}>
					<label htmlFor="repo-url" style={styles.label}>
						Repository URL
					</label>
					<div style={styles.inputWrapper}>
						<input
							ref={urlInputRef}
							id="repo-url"
							type="text"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onBlur={handleBlur}
							onKeyDown={handleKeyDown}
							placeholder="https://github.com/user/repo or git@github.com:user/repo.git"
							style={styles.input}
							disabled={connectionState === "connecting"}
						/>
						<div style={styles.statusIcon}>{getStatusIcon(validationState, connectionState)}</div>
					</div>
					{validationError && <p style={styles.error}>{validationError}</p>}
					{normalizedUrl && validationState === "valid" && (
						<p style={styles.normalized}>→ {normalizedUrl}</p>
					)}
				</div>

				<div style={styles.inputGroup}>
					<label htmlFor="repo-commit" style={styles.label}>
						Commit / Branch / Tag <span style={styles.optional}>(optional)</span>
					</label>
					<input
						id="repo-commit"
						type="text"
						value={commit}
						onChange={(e) => setCommit(e.target.value)}
						onBlur={handleBlur}
						onKeyDown={handleKeyDown}
						placeholder="main, v1.0.0, abc1234... (defaults to main or master)"
						style={styles.inputSmall}
						disabled={connectionState === "connecting"}
					/>
				</div>

				{connectionState === "connecting" && (
					<div style={styles.loading}>
						<Spinner />
						<span>Connecting and analyzing repository...</span>
					</div>
				)}

				{connectionError && <p style={styles.error}>{connectionError}</p>}

				{connectionResult && (
					<div style={styles.result}>
						<div style={styles.resultHeader}>
							<h2 style={styles.resultTitle}>About this repository</h2>
							<code style={styles.commitBadge} title={`Full commit: ${connectionResult.commitish}`}>
								{connectionResult.commitish.slice(0, 7)}
							</code>
						</div>
						<div 
							style={styles.markdownContent} 
							className="markdown-content"
							dangerouslySetInnerHTML={{ __html: marked(connectionResult.summary) as string }}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

function getStatusIcon(validation: ValidationState, connection: ConnectionState): React.ReactNode {
	if (connection === "connected") {
		return <span style={{ color: "#10b981", fontSize: "20px" }}>✓</span>;
	}
	if (validation === "validating" || connection === "connecting") {
		return <Spinner />;
	}
	if (validation === "valid") {
		return <span style={{ color: "#10b981", fontSize: "20px" }}>✓</span>;
	}
	if (validation === "invalid") {
		return <span style={{ color: "#ef4444", fontSize: "20px" }}>✗</span>;
	}
	return null;
}

function Spinner() {
	return (
		<div
			style={{
				width: "18px",
				height: "18px",
				border: "2px solid #e5e7eb",
				borderTopColor: "#3b82f6",
				borderRadius: "50%",
				animation: "spin 0.8s linear infinite",
			}}
		/>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		minHeight: "100vh",
		backgroundColor: "#f9fafb",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		padding: "20px",
		fontFamily: "system-ui, -apple-system, sans-serif",
	},
	card: {
		backgroundColor: "white",
		borderRadius: "12px",
		boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
		padding: "40px",
		maxWidth: "600px",
		width: "100%",
	},
	title: {
		margin: "0 0 8px 0",
		fontSize: "28px",
		fontWeight: 700,
		color: "#111827",
	},
	subtitle: {
		margin: "0 0 32px 0",
		color: "#6b7280",
		fontSize: "16px",
	},
	inputGroup: {
		marginBottom: "20px",
	},
	label: {
		display: "block",
		marginBottom: "8px",
		fontWeight: 500,
		color: "#374151",
		fontSize: "14px",
	},
	optional: {
		fontWeight: 400,
		color: "#9ca3af",
		fontSize: "12px",
	},
	inputWrapper: {
		position: "relative",
		display: "flex",
		alignItems: "center",
	},
	input: {
		width: "100%",
		padding: "12px 40px 12px 16px",
		fontSize: "15px",
		border: "1px solid #d1d5db",
		borderRadius: "8px",
		outline: "none",
		transition: "border-color 0.2s, box-shadow 0.2s",
	},
	inputSmall: {
		width: "100%",
		padding: "10px 16px",
		fontSize: "14px",
		border: "1px solid #d1d5db",
		borderRadius: "8px",
		outline: "none",
		transition: "border-color 0.2s, box-shadow 0.2s",
	},
	statusIcon: {
		position: "absolute",
		right: "12px",
		display: "flex",
		alignItems: "center",
	},
	error: {
		marginTop: "8px",
		color: "#ef4444",
		fontSize: "14px",
	},
	normalized: {
		marginTop: "8px",
		color: "#6b7280",
		fontSize: "13px",
		fontFamily: "monospace",
	},
	loading: {
		display: "flex",
		alignItems: "center",
		gap: "12px",
		color: "#6b7280",
		fontSize: "14px",
		marginBottom: "24px",
	},
	result: {
		backgroundColor: "#f9fafb",
		borderRadius: "8px",
		padding: "20px",
		marginTop: "8px",
	},
	resultHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: "12px",
	},
	resultTitle: {
		margin: 0,
		fontSize: "16px",
		fontWeight: 600,
		color: "#111827",
	},
	commitBadge: {
		backgroundColor: "#e5e7eb",
		padding: "2px 8px",
		borderRadius: "4px",
		fontSize: "11px",
		color: "#6b7280",
		fontFamily: "ui-monospace, monospace",
		cursor: "default",
	},
	markdownContent: {
		color: "#374151",
		lineHeight: 1.6,
		fontSize: "15px",
	},
};
