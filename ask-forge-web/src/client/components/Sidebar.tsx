import { useEffect, useRef, useState, useCallback } from "react";
import type { AuthState, SessionSummary } from "../types.ts";

const BOOKMARKLET_CODE = "javascript:location='https://ask.nilenso.ai/go?url='+encodeURIComponent(location.href)";

interface SidebarProps {
	auth: AuthState;
	sidebarCollapsed: boolean;
	setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
	sessionHistory: SessionSummary[];
	historyLoading: boolean;
	renamingSession: string | null;
	renameValue: string;
	setRenamingSession: (id: string | null) => void;
	setRenameValue: (value: string) => void;
	handleDisconnect: () => void;
	handleLogout: () => void;
	handleRestore: (session: SessionSummary) => void;
	handleDeleteSession: (sessionId: string) => void;
	handleRenameSession: (sessionId: string, title: string) => void;
}

export function Sidebar({
	auth,
	sidebarCollapsed,
	setSidebarCollapsed,
	sessionHistory,
	historyLoading,
	renamingSession,
	renameValue,
	setRenamingSession,
	setRenameValue,
	handleDisconnect,
	handleLogout,
	handleRestore,
	handleDeleteSession,
	handleRenameSession,
}: SidebarProps) {
	const [profileOpen, setProfileOpen] = useState(false);
	const [itemMenuOpen, setItemMenuOpen] = useState<string | null>(null);
	const profileRef = useRef<HTMLDivElement>(null);
	const itemMenuRef = useRef<HTMLDivElement>(null);
	const bookmarkletRef = useRef<HTMLAnchorElement>(null);

	// Set bookmarklet href directly on DOM to bypass React's javascript: URL blocking
	useEffect(() => {
		if (bookmarkletRef.current) {
			bookmarkletRef.current.setAttribute("href", BOOKMARKLET_CODE);
		}
	}, [sidebarCollapsed]);

	// Close profile menu and item menu on outside click
	useEffect(() => {
		const handleClick = (e: MouseEvent) => {
			if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
				setProfileOpen(false);
			}
			if (itemMenuRef.current && !itemMenuRef.current.contains(e.target as Node)) {
				setItemMenuOpen(null);
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, []);

	if (!auth.authenticated) return null;

	return (
		<nav className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
			<div className="sidebar-top">
				{!sidebarCollapsed && (
					<h1 className="sidebar-logo">
						<span className="logo-ask">ask</span>
						<span className="logo-forge">forge</span>
					</h1>
				)}
				<button
					type="button"
					className="sidebar-collapse-btn"
					onClick={() => setSidebarCollapsed((c) => !c)}
					aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<line x1="9" y1="3" x2="9" y2="21" />
					</svg>
				</button>
			</div>
			<button type="button" className="sidebar-new-chat" onClick={handleDisconnect} aria-label="New chat">
				<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
				</svg>
				{!sidebarCollapsed && "New chat"}
			</button>
			{!sidebarCollapsed && (
				<div className="sidebar-content">
					<div className="sidebar-section-label">Recents</div>
					{historyLoading ? (
						<div className="sidebar-loading">
							<span className="spinner" />
						</div>
					) : sessionHistory.length === 0 ? (
						<div className="sidebar-empty">No sessions yet</div>
					) : (
						sessionHistory.map((s) => (
							<div
								key={s.id}
								className="sidebar-item"
								role="button"
								tabIndex={0}
								onClick={() => {
									if (renamingSession !== s.id) handleRestore(s);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && renamingSession !== s.id) handleRestore(s);
								}}
							>
								{renamingSession === s.id ? (
									<input
										type="text"
										className="sidebar-rename-input"
										value={renameValue}
										onChange={(e) => setRenameValue(e.target.value)}
										onKeyDown={(e) => {
											e.stopPropagation();
											if (e.key === "Enter") handleRenameSession(s.id, renameValue);
											if (e.key === "Escape") setRenamingSession(null);
										}}
										onBlur={() => handleRenameSession(s.id, renameValue)}
										autoFocus
										onClick={(e) => e.stopPropagation()}
									/>
								) : (
									<div className="sidebar-item-title">{s.title || "New conversation"}</div>
								)}
								<div className="sidebar-item-menu-wrapper" ref={itemMenuOpen === s.id ? itemMenuRef : undefined}>
									<button
										type="button"
										className="sidebar-item-more"
										onClick={(e) => {
											e.stopPropagation();
											setItemMenuOpen(itemMenuOpen === s.id ? null : s.id);
										}}
										aria-label="More options"
									>
										<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
											<circle cx="10" cy="4" r="1.5" />
											<circle cx="10" cy="10" r="1.5" />
											<circle cx="10" cy="16" r="1.5" />
										</svg>
									</button>
									{itemMenuOpen === s.id && (
										<div className="sidebar-item-dropdown">
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													setRenameValue(s.title || "");
													setRenamingSession(s.id);
													setItemMenuOpen(null);
												}}
											>
												<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
													<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
													<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
												</svg>
												Rename
											</button>
											<button
												type="button"
												className="danger"
												onClick={(e) => {
													e.stopPropagation();
													setItemMenuOpen(null);
													if (confirm("Delete this session?")) {
														handleDeleteSession(s.id);
													}
												}}
											>
												<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
													<polyline points="3 6 5 6 21 6" />
													<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
												</svg>
												Delete
											</button>
										</div>
									)}
								</div>
							</div>
						))
					)}
				</div>
			)}
			{!sidebarCollapsed && (
				<div className="sidebar-bookmarklet">
					<a
						ref={bookmarkletRef}
						href="#"
						className="bookmarklet-link"
						onClick={(e) => e.preventDefault()}
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
							<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
						</svg>
						AskForge!
					</a>
					<span className="bookmarklet-hint">↑ Drag to bookmarks bar</span>
				</div>
			)}
			<div className="sidebar-footer" ref={profileRef}>
				{profileOpen && !sidebarCollapsed && (
					<div className="sidebar-profile-menu">
						<button
							type="button"
							className="sidebar-profile-menu-item"
							onClick={() => {
								setProfileOpen(false);
								handleLogout();
							}}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
								<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
								<polyline points="16 17 21 12 16 7" />
								<line x1="21" y1="12" x2="9" y2="12" />
							</svg>
							Sign out
						</button>
					</div>
				)}
				<button
					type="button"
					className="sidebar-profile"
					onClick={() => (sidebarCollapsed ? setSidebarCollapsed(false) : setProfileOpen((p) => !p))}
				>
					{auth.avatarUrl ? (
						<img src={auth.avatarUrl} alt="" className="sidebar-profile-avatar" />
					) : (
						<div className="sidebar-profile-placeholder">{auth.username?.[0]?.toUpperCase() || "?"}</div>
					)}
					{!sidebarCollapsed && <span className="sidebar-profile-name">{auth.username}</span>}
				</button>
			</div>
		</nav>
	);
}
