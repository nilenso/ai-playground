// Content blocks represent ordered segments of text and tool calls
export type ContentBlock =
	| { type: "text"; content: string }
	| { type: "tool_call"; name: string; arguments: Record<string, unknown>; isComplete: boolean };

export interface Message {
	id: string;
	role: "user" | "assistant";
	contentBlocks: ContentBlock[];
	thinking?: string;
	isStreaming?: boolean;
}

export interface ConnectionState {
	status: "disconnected" | "connecting" | "connected" | "error";
	sessionId: string | null;
	commitish: string | null;
	error: string | null;
	repoName: string | null;
}

export interface ProgressState {
	type: "idle" | "thinking" | "tool" | "responding";
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	thinkingContent?: string;
	textContent?: string;
}

export interface AuthState {
	authenticated: boolean;
	username: string | null;
	avatarUrl: string | null;
	loading: boolean;
	error?: string | null;
}

export interface SessionSummary {
	id: string;
	title: string | null;
	status: string;
	created_at: string;
	repository_name: string;
	username_or_organization: string;
	git_url: string;
}

export type AppPhase = "connect" | "ask" | "chat";
