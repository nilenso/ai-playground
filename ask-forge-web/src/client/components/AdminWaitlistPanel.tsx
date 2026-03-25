import { useCallback, useEffect, useState } from "react";

interface AdminUser {
	id: number;
	username: string;
	display_name: string | null;
	email: string | null;
	avatar_url: string | null;
	status: string;
	created_at: string;
}

interface GroupedUsers {
	waitlisted: AdminUser[];
	approved: AdminUser[];
	disabled: AdminUser[];
}

interface AdminWaitlistPanelProps {
	onClose: () => void;
}

export function AdminWaitlistPanel({ onClose }: AdminWaitlistPanelProps) {
	const [groups, setGroups] = useState<GroupedUsers>({ waitlisted: [], approved: [], disabled: [] });
	const [loading, setLoading] = useState(true);
	const [acting, setActing] = useState<number | null>(null);
	const [approvedOpen, setApprovedOpen] = useState(false);
	const [disabledOpen, setDisabledOpen] = useState(false);

	const fetchUsers = useCallback(() => {
		setLoading(true);
		fetch("/api/auth/admin/users")
			.then((res) => res.json())
			.then((data: GroupedUsers) => {
				setGroups(data);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, []);

	useEffect(() => {
		fetchUsers();
	}, [fetchUsers]);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const handleAction = useCallback(
		async (userId: number, action: "approve" | "disapprove" | "disable") => {
			setActing(userId);
			try {
				const res = await fetch(`/api/auth/admin/${action}/${userId}`, { method: "POST" });
				if (res.ok) fetchUsers();
			} finally {
				setActing(null);
			}
		},
		[fetchUsers],
	);

	function renderUserRow(user: AdminUser, actions: React.ReactNode) {
		return (
			<div key={user.id} className="admin-panel-user">
				<div className="admin-panel-user-info">
					{user.avatar_url ? (
						<img src={user.avatar_url} alt="" className="admin-panel-avatar" />
					) : (
						<div className="admin-panel-avatar-placeholder">{user.username[0]?.toUpperCase() || "?"}</div>
					)}
					<div>
						<div className="admin-panel-username">{user.username}</div>
						{user.display_name && <div className="admin-panel-display-name">{user.display_name}</div>}
						{user.email && <div className="admin-panel-display-name">{user.email}</div>}
						<div className="admin-panel-date">
							Signed up{" "}
							{new Date(user.created_at).toLocaleDateString("en-US", {
								month: "short",
								day: "numeric",
								year: "numeric",
							})}
						</div>
					</div>
				</div>
				<div className="admin-panel-actions">{actions}</div>
			</div>
		);
	}

	const totalUsers = groups.waitlisted.length + groups.approved.length + groups.disabled.length;

	return (
		<div
			className="admin-panel-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Manage Users"
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: prevent close on panel click */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by overlay */}
			<div className="admin-panel" onClick={(e) => e.stopPropagation()}>
				<div className="admin-panel-header">
					<h2>Manage Users</h2>
					<button type="button" className="admin-panel-close" onClick={onClose} aria-label="Close">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				<div className="admin-panel-body">
					{loading ? (
						<div className="admin-panel-loading">
							<span className="spinner" />
						</div>
					) : totalUsers === 0 ? (
						<div className="admin-panel-empty">
							<svg
								width="40"
								height="40"
								viewBox="0 0 24 24"
								fill="none"
								stroke="var(--text-tertiary)"
								strokeWidth="1.5"
								aria-hidden="true"
							>
								<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
								<polyline points="22 4 12 14.01 9 11.01" />
							</svg>
							<p>No users yet</p>
						</div>
					) : (
						<>
							{/* ── Pending approval ── */}
							<div className="admin-panel-section">
								<div className="admin-panel-section-label">
									Pending approval
									{groups.waitlisted.length > 0 && (
										<span className="admin-panel-section-count">{groups.waitlisted.length}</span>
									)}
								</div>
								{groups.waitlisted.length === 0 ? (
									<div className="admin-panel-section-empty">No pending users</div>
								) : (
									<div className="admin-panel-list">
										{groups.waitlisted.map((user) =>
											renderUserRow(
												user,
												<>
													<button
														type="button"
														className="admin-panel-approve-btn"
														onClick={() => handleAction(user.id, "approve")}
														disabled={acting === user.id}
													>
														{acting === user.id ? <span className="spinner" /> : "Approve"}
													</button>
													<button
														type="button"
														className="admin-panel-disapprove-btn"
														onClick={() => handleAction(user.id, "disapprove")}
														disabled={acting === user.id}
														title="Disapprove"
													>
														✕
													</button>
												</>,
											),
										)}
									</div>
								)}
							</div>

							{/* ── Approved ── */}
							<div className="admin-panel-section">
								<button
									type="button"
									className="admin-panel-section-toggle"
									onClick={() => setApprovedOpen((o) => !o)}
								>
									<svg
										className={`admin-panel-chevron ${approvedOpen ? "open" : ""}`}
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										aria-hidden="true"
									>
										<polyline points="9 18 15 12 9 6" />
									</svg>
									Approved
									{groups.approved.length > 0 && (
										<span className="admin-panel-section-count">{groups.approved.length}</span>
									)}
								</button>
								{approvedOpen && (
									<div className="admin-panel-list">
										{groups.approved.length === 0 ? (
											<div className="admin-panel-section-empty">No approved users</div>
										) : (
											groups.approved.map((user) =>
												renderUserRow(
													user,
													<button
														type="button"
														className="admin-panel-disable-btn"
														onClick={() => handleAction(user.id, "disable")}
														disabled={acting === user.id}
														title="Disable user"
													>
														{acting === user.id ? <span className="spinner" /> : "Disable"}
													</button>,
												),
											)
										)}
									</div>
								)}
							</div>

							{/* ── Disapproved / Disabled ── */}
							{groups.disabled.length > 0 && (
								<div className="admin-panel-section">
									<button
										type="button"
										className="admin-panel-section-toggle"
										onClick={() => setDisabledOpen((o) => !o)}
									>
										<svg
											className={`admin-panel-chevron ${disabledOpen ? "open" : ""}`}
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											aria-hidden="true"
										>
											<polyline points="9 18 15 12 9 6" />
										</svg>
										Disapproved / Disabled
										<span className="admin-panel-section-count">{groups.disabled.length}</span>
									</button>
									{disabledOpen && (
										<div className="admin-panel-list">
											{groups.disabled.map((user) =>
												renderUserRow(
													user,
													<span className="admin-panel-status-label">
														{user.status === "disapproved" ? "Disapproved" : "Disabled"}
													</span>,
												),
											)}
										</div>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
