import { useCallback, useEffect, useState } from "react";

interface WaitlistedUser {
	id: number;
	username: string;
	display_name: string | null;
	email: string | null;
	avatar_url: string | null;
	created_at: string;
}

interface AdminWaitlistPanelProps {
	onClose: () => void;
}

export function AdminWaitlistPanel({ onClose }: AdminWaitlistPanelProps) {
	const [users, setUsers] = useState<WaitlistedUser[]>([]);
	const [loading, setLoading] = useState(true);
	const [approving, setApproving] = useState<number | null>(null);

	const fetchWaitlist = useCallback(() => {
		setLoading(true);
		fetch("/api/auth/admin/waitlist")
			.then((res) => res.json())
			.then((data) => {
				setUsers(data);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, []);

	useEffect(() => {
		fetchWaitlist();
	}, [fetchWaitlist]);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const handleApprove = useCallback(async (userId: number) => {
		setApproving(userId);
		try {
			const res = await fetch(`/api/auth/admin/approve/${userId}`, { method: "POST" });
			if (res.ok) {
				setUsers((prev) => prev.filter((u) => u.id !== userId));
			}
		} finally {
			setApproving(null);
		}
	}, []);

	return (
		<div
			className="admin-panel-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Waitlisted Users"
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: prevent close on panel click */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by overlay */}
			<div className="admin-panel" onClick={(e) => e.stopPropagation()}>
				<div className="admin-panel-header">
					<h2>Waitlisted Users</h2>
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
					) : users.length === 0 ? (
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
							<p>No users on the waitlist</p>
						</div>
					) : (
						<div className="admin-panel-list">
							{users.map((user) => (
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
									<button
										type="button"
										className="admin-panel-approve-btn"
										onClick={() => handleApprove(user.id)}
										disabled={approving === user.id}
									>
										{approving === user.id ? <span className="spinner" /> : "Approve"}
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
