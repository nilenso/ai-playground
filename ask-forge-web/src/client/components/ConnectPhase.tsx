import type { AuthState, ConnectionState } from "../types.ts";
import { Sidebar } from "./Sidebar.tsx";

interface ConnectPhaseProps {
	auth: AuthState;
	connection: ConnectionState;
	url: string;
	setUrl: (url: string) => void;
	buildTime: string | null;
	bookmarkletError: string | null;
	handleConnect: () => void;
	handleLogin: () => void;
	handleKeyDown: (e: React.KeyboardEvent) => void;
	urlInputRef: React.RefObject<HTMLInputElement | null>;
	sidebarProps: React.ComponentProps<typeof Sidebar>;
}

export function ConnectPhase({
	auth,
	connection,
	url,
	setUrl,
	buildTime,
	bookmarkletError,
	handleConnect,
	handleLogin,
	handleKeyDown,
	urlInputRef,
	sidebarProps,
}: ConnectPhaseProps) {
	// Show loading while checking auth
	if (auth.loading) {
		return (
			<div className="app-container phase-connect">
				<div className="app-main">
					<div className="connect-content">
						<h1 className="logo">
							<span className="logo-ask">ask</span>
							<span className="logo-forge">forge</span>
						</h1>
						<div className="auth-loading">
							<span className="spinner" />
						</div>
					</div>
				</div>
			</div>
		);
	}

	// Show login if not authenticated
	if (!auth.authenticated) {
		return (
			<div className="app-container phase-connect">
				<div className="app-main">
					<div className="connect-content">
						<h1 className="logo">
							<span className="logo-ask">ask</span>
							<span className="logo-forge">forge</span>
						</h1>
						{auth.error && <div className="error-message">{auth.error}</div>}
						{bookmarkletError && <div className="error-message">{bookmarkletError}</div>}
						<button type="button" className="login-button" onClick={handleLogin}>
							<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							Sign in with GitHub
						</button>
						<p className="hint">Sign in to start exploring repositories</p>
						<p className="data-notice">
							All conversations are used for improving ask forge and may end up in a{" "}
							<a
								href="https://huggingface.co/datasets/nilenso/ask-forge-eval-dataset"
								target="_blank"
								rel="noopener noreferrer"
							>
								public dataset
							</a>
							.
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="app-container phase-connect">
			<Sidebar {...sidebarProps} />
			<div className="app-main">
				<div className="connect-content">
					<h2 className="greeting">
						{connection.status === "connecting" ? connection.progressMessage || "Connecting…" : "What can I help with?"}
					</h2>

					<div className="input-container">
						<input
							ref={urlInputRef}
							type="text"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Enter repository URL..."
							className="main-input"
							disabled={connection.status === "connecting"}
						/>
						<button
							type="button"
							className="connect-button"
							onClick={handleConnect}
							disabled={connection.status === "connecting" || !url.trim()}
						>
							{connection.status === "connecting" ? <span className="spinner" /> : "Connect"}
						</button>
					</div>

					{connection.error && <div className="error-message">{connection.error}</div>}
					{bookmarkletError && <div className="error-message">{bookmarkletError}</div>}

					<p className="hint">Paste a GitHub, GitLab, or Bitbucket URL</p>
					<p className="data-notice">
						All conversations are used for improving ask forge and may end up in a{" "}
						<a
							href="https://huggingface.co/datasets/nilenso/ask-forge-eval-dataset"
							target="_blank"
							rel="noopener noreferrer"
						>
							public dataset
						</a>
						.
					</p>
				</div>
				{buildTime && (
					<div className="deploy-info">
						{new Date(buildTime).toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}
					</div>
				)}
			</div>
		</div>
	);
}
