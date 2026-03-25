import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthState } from "../types.ts";

interface UseAuthOptions {
	connectionSessionId: string | null;
	onLogout: () => void;
}

export function useAuth({ connectionSessionId, onLogout }: UseAuthOptions) {
	const [auth, setAuth] = useState<AuthState>({
		authenticated: false,
		username: null,
		avatarUrl: null,
		loading: true,
	});

	// Track whether we already processed an error from the URL,
	// so StrictMode's second mount doesn't overwrite it by fetching /api/auth/status
	const errorProcessedRef = useRef(false);

	// Check auth status on mount and handle OAuth errors
	useEffect(() => {
		if (errorProcessedRef.current) return;

		const params = new URLSearchParams(window.location.search);
		const authError = params.get("error");
		if (authError) {
			errorProcessedRef.current = true;
			window.history.replaceState({}, "", window.location.pathname);
			const errorMessages: Record<string, string> = {
				oauth_denied: "GitHub authorization was denied",
				invalid_callback: "Invalid OAuth callback",
				invalid_state: "Invalid OAuth state - please try again",
				token_exchange_failed: "Failed to exchange OAuth token",
				user_fetch_failed: "Failed to fetch user info from GitHub",
				user_not_found: "User not found",
				auth_failed: "Authentication failed - please try again",
				not_allowed: "Signups are currently restricted. Your GitHub account is not on the allowlist.",
			};
			setAuth({
				authenticated: false,
				username: null,
				avatarUrl: null,
				loading: false,
				error: errorMessages[authError] || "Authentication failed",
			});
			return;
		}

		fetch("/api/auth/status")
			.then((res) => res.json())
			.then((data) => {
				setAuth({
					authenticated: data.authenticated,
					username: data.username || null,
					avatarUrl: data.avatarUrl || null,
					loading: false,
					error: null,
					status: data.status || undefined,
					isAdmin: data.isAdmin || false,
					waitlistCount: data.waitlistCount || 0,
				});
			})
			.catch(() => {
				setAuth({ authenticated: false, username: null, avatarUrl: null, loading: false, error: null });
			});
	}, []);

	const handleLogin = useCallback(() => {
		window.location.href = "/api/auth/github";
	}, []);

	const handleLogout = useCallback(async () => {
		// Let the caller handle WS cleanup and state reset
		onLogout();

		// Disconnect server session if active
		if (connectionSessionId) {
			fetch("/api/disconnect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: connectionSessionId }),
			}).catch(() => {}); // Fire and forget
		}

		// Clear auth and cached state
		localStorage.removeItem("askforge_repo_url");
		await fetch("/api/auth/logout", { method: "POST" });
		setAuth({ authenticated: false, username: null, avatarUrl: null, loading: false });
	}, [connectionSessionId, onLogout]);

	const refreshAuth = useCallback(() => {
		fetch("/api/auth/status")
			.then((res) => res.json())
			.then((data) => {
				if (data.authenticated) {
					setAuth((prev) => ({
						...prev,
						status: data.status || prev.status,
						isAdmin: data.isAdmin ?? prev.isAdmin,
						waitlistCount: data.waitlistCount || 0,
					}));
				}
			})
			.catch(() => {});
	}, []);

	return { auth, handleLogin, handleLogout, refreshAuth };
}
