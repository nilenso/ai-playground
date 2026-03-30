/**
 * Slack service implementation using Bolt.js.
 */

import type { App } from "@slack/bolt";
import { App as BoltApp } from "@slack/bolt";
import type { SlackConfig } from "../../config/index.js";
import type {
	ActionHandler,
	MessageHandler,
	PostMessageOptions,
	SentMessage,
	SlackMessage,
	SlackService,
	SlackUserInfo,
	UpdateMessageOptions,
} from "../../interfaces/slack.js";

export class BoltSlackService implements SlackService {
	private app: App;
	private handlers: MessageHandler[] = [];

	constructor(config: SlackConfig) {
		this.app = new BoltApp({
			token: config.botToken,
			signingSecret: config.signingSecret,
			appToken: config.appToken,
			socketMode: true,
			port: config.port,
		});

		// Wire up Bolt's message listener to our handler chain
		this.app.message(async ({ message, say }) => {
			// Bolt types are broad — we only care about plain messages with text
			if (message.subtype !== undefined) return;
			const msg = message as {
				text?: string;
				user?: string;
				channel?: string;
				ts?: string;
				thread_ts?: string;
				bot_id?: string;
			};

			if (!msg.text || !msg.user || !msg.channel || !msg.ts) return;

			const incoming: SlackMessage = {
				text: msg.text,
				userId: msg.user,
				channelId: msg.channel,
				ts: msg.ts,
				threadTs: msg.thread_ts,
				botId: msg.bot_id,
			};

			for (const handler of this.handlers) {
				const reply = await handler(incoming);
				if (reply) {
					await say({ text: reply, thread_ts: msg.thread_ts ?? msg.ts });
				}
			}
		});
	}

	// ── Lifecycle ──────────────────────────────

	async start(): Promise<void> {
		await this.app.start();
		console.log("⚡ Slack bot is running");
	}

	async stop(): Promise<void> {
		await this.app.stop();
		console.log("Slack bot stopped");
	}

	// ── Incoming events ───────────────────────

	onMessage(handler: MessageHandler): void {
		this.handlers.push(handler);
	}

	onAction(pattern: RegExp, handler: ActionHandler): void {
		this.app.action(pattern, async ({ ack, body }) => {
			await ack();

			const action = (body as { actions?: { action_id?: string; value?: string }[] }).actions?.[0];
			const user = (body as { user?: { id?: string } }).user;
			const channel = (body as { channel?: { id?: string } }).channel;
			const message = (body as { message?: { ts?: string; thread_ts?: string } }).message;

			if (!action?.action_id || !user?.id || !channel?.id || !message?.ts) return;

			await handler({
				actionId: action.action_id,
				value: action.value ?? "",
				userId: user.id,
				channelId: channel.id,
				messageTs: message.ts,
				threadTs: message.thread_ts,
			});
		});
	}

	// ── Outgoing messages ─────────────────────

	async postMessage(channel: string, options: PostMessageOptions): Promise<SentMessage> {
		const result = await this.app.client.chat.postMessage({
			channel,
			text: options.text ?? "",
			blocks: options.blocks,
			thread_ts: options.threadTs,
		});

		return {
			ts: result.ts as string,
			channelId: channel,
		};
	}

	async updateMessage(channel: string, ts: string, options: UpdateMessageOptions): Promise<void> {
		await this.app.client.chat.update({
			channel,
			ts,
			text: options.text ?? "",
			blocks: options.blocks,
		});
	}

	// ── Read APIs ─────────────────────────────

	async getThreadReplies(channel: string, ts: string): Promise<SlackMessage[]> {
		const result = await this.app.client.conversations.replies({
			channel,
			ts,
			inclusive: true,
		});

		return (result.messages ?? []).map((msg) => ({
			text: (msg as { text?: string }).text ?? "",
			userId: (msg as { user?: string }).user ?? "",
			channelId: channel,
			ts: (msg as { ts?: string }).ts ?? "",
			threadTs: (msg as { thread_ts?: string }).thread_ts,
			botId: (msg as { bot_id?: string }).bot_id,
		}));
	}

	async getChannelMembers(channel: string): Promise<string[]> {
		const members: string[] = [];
		let cursor: string | undefined;

		do {
			const result = await this.app.client.conversations.members({
				channel,
				cursor,
				limit: 200,
			});
			if (result.members) {
				members.push(...result.members);
			}
			cursor = result.response_metadata?.next_cursor || undefined;
		} while (cursor);

		return members;
	}

	async getUserInfo(userId: string): Promise<SlackUserInfo> {
		const result = await this.app.client.users.info({ user: userId });
		const user = result.user as {
			id?: string;
			name?: string;
			real_name?: string;
			is_bot?: boolean;
			tz?: string;
			profile?: { display_name?: string; email?: string };
		};

		return {
			userId,
			displayName: user?.profile?.display_name || user?.name || userId,
			realName: user?.real_name,
			email: user?.profile?.email,
			timezone: user?.tz,
			isBot: user?.is_bot ?? false,
		};
	}
}
