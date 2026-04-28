/**
 * Slack service interface.
 *
 * A Slack-specific abstraction over the Bolt.js SDK. Exposes the subset of
 * Slack's API surface that Jadoo plugins need: messaging, Block Kit, button
 * actions, thread context, and user info.
 *
 * Still an interface (not a concrete class) so tests can mock it without
 * touching the real Slack API.
 */

import type { KnownBlock, Block as SlackBlock } from "@slack/types";

// ─── Block Kit ──────────────────────────────────────────

/**
 * A Slack Block Kit block. We use @slack/types to maintain
 * accurate strict typings for blocks (e.g. KnownBlock | Block).
 *
 * See: https://api.slack.com/reference/block-kit/blocks
 */
export type Block = KnownBlock | SlackBlock;

// ─── Messages ───────────────────────────────────────────

/** An incoming Slack message (from a user, in a channel). */
export interface SlackMessage {
	/** The raw text of the message */
	text: string;
	/** Slack user ID of the sender */
	userId: string;
	/** Channel / conversation ID */
	channelId: string;
	/** Message timestamp (Slack's unique message ID) */
	ts: string;
	/** Thread timestamp — present if this is a reply in a thread */
	threadTs?: string;
	/** Bot ID — present if sent by a bot */
	botId?: string;
}

/** What postMessage returns — enough to later update or reference it. */
export interface SentMessage {
	ts: string;
	channelId: string;
}

/** Options for postMessage. */
export interface PostMessageOptions {
	/** Plain text (used as fallback for notifications) */
	text?: string;
	/** Block Kit blocks */
	blocks?: Block[];
	/** Thread to reply in */
	threadTs?: string;
}

/** Options for updateMessage. */
export interface UpdateMessageOptions {
	/** Replacement plain text */
	text?: string;
	/** Replacement Block Kit blocks */
	blocks?: Block[];
}

// ─── Actions (buttons, menus, etc.) ─────────────────────

/** Payload delivered when a user clicks a button / interacts with a Block Kit element. */
export interface ActionEvent {
	/** The action_id of the element that was clicked */
	actionId: string;
	/** The value attached to the action */
	value: string;
	/** Slack user ID of the person who clicked */
	userId: string;
	/** Channel where the interaction happened */
	channelId: string;
	/** Timestamp of the message containing the action */
	messageTs: string;
	/** Thread timestamp, if the message is in a thread */
	threadTs?: string;
}

/**
 * Handler for Slack interactive actions. Receives the event after ack()
 * has already been called by the framework.
 */
export type ActionHandler = (event: ActionEvent) => Promise<void>;

// ─── Slash commands ─────────────────────────────────────

export interface SlashCommandResponseOptions {
	/** Plain text response */
	text?: string;
	/** Block Kit blocks */
	blocks?: Block[];
	/** Slack response visibility */
	responseType?: "ephemeral" | "in_channel";
}

export interface SlashCommandEvent {
	/** Command name, e.g. /jadoo-sync */
	command: string;
	/** Free-form text after the command */
	text: string;
	/** Slack user ID of the invoker */
	userId: string;
	/** Channel where the command was invoked */
	channelId: string;
	/** Send a response via Slack's slash-command response channel. */
	respond(options: SlashCommandResponseOptions): Promise<void>;
}

export type SlashCommandHandler = (event: SlashCommandEvent) => Promise<void>;

// ─── User info ──────────────────────────────────────────

export interface SlackUserInfo {
	userId: string;
	displayName: string;
	realName?: string;
	email?: string;
	timezone?: string;
	isBot: boolean;
}

// ─── Message handler ────────────────────────────────────

/**
 * Handler for incoming messages. Returns the text to reply with,
 * or null/undefined to not reply.
 */
export type MessageHandler = (message: SlackMessage) => Promise<string | null | undefined>;

// ─── Service interface ──────────────────────────────────

export interface SlackService {
	// ── Lifecycle ──────────────────────────────

	/** Start listening (Socket Mode). */
	start(): Promise<void>;

	/** Stop and clean up. */
	stop(): Promise<void>;

	// ── Incoming events ───────────────────────

	/**
	 * Register a handler that fires on every incoming message.
	 * If the handler returns a non-null string, the framework sends it as a
	 * threaded reply automatically.
	 */
	onMessage(handler: MessageHandler): void;

	/**
	 * Register a handler for button / interactive actions.
	 * `pattern` is a regex matched against the action_id.
	 *
	 * The framework calls Slack's ack() before invoking the handler.
	 */
	onAction(pattern: RegExp, handler: ActionHandler): void;

	/**
	 * Register a handler for a slash command, e.g. `/jadoo-sync`.
	 * The framework acks the command before invoking the handler.
	 */
	onCommand(command: string, handler: SlashCommandHandler): void;

	// ── Outgoing messages ─────────────────────

	/**
	 * Post a message to a channel (with optional Block Kit blocks and threading).
	 */
	postMessage(channel: string, options: PostMessageOptions): Promise<SentMessage>;

	/**
	 * Update an existing message (replace text and/or blocks).
	 */
	updateMessage(channel: string, ts: string, options: UpdateMessageOptions): Promise<void>;

	// ── Read APIs ─────────────────────────────

	/**
	 * Fetch all messages in a thread (conversations.replies).
	 */
	getThreadReplies(channel: string, ts: string): Promise<SlackMessage[]>;

	/**
	 * Get user profile information (users.info).
	 */
	getUserInfo(userId: string): Promise<SlackUserInfo>;

	/**
	 * List all member IDs in a channel (conversations.members, handles pagination).
	 */
	getChannelMembers(channel: string): Promise<string[]>;
}
