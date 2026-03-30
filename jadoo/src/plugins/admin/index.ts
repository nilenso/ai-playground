/**
 * Admin plugin — provides a "sync users" button for importing Slack channel
 * members and linking their Harvest accounts by email.
 *
 * Listens for messages containing "!sync" in the configured leave channel
 * (from non-bot users only). Responds with a confirmation button, then runs
 * the import on confirm.
 */

import type { Database } from "bun:sqlite";
import type { PluginConfigSchema } from "../../config/plugin-config.js";
import { createUser, getUserBySlackId, listUsers, updateUser } from "../../db/index.js";
import type { BotContext, Plugin } from "../../interfaces/plugin.js";

export class AdminPlugin implements Plugin {
	readonly name = "admin";
	readonly configSchema: PluginConfigSchema = {
		channelId: {
			envVar: "SLACK_LEAVE_CHANNEL_ID",
			description: "Channel ID to monitor for admin commands",
			required: true,
		},
	};

	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	async init(ctx: BotContext, config: Record<string, string | undefined>) {
		const channelId = config.channelId as string;

		// Listen for "!sync" messages
		ctx.slack.onMessage(async (msg) => {
			if (msg.botId) return null;
			if (msg.channelId !== channelId) return null;
			if (!msg.text.trim().toLowerCase().startsWith("!sync")) return null;

			await ctx.slack.postMessage(msg.channelId, {
				text: "Sync users from Slack & Harvest?",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "🔄 *Sync users*\n\nThis will:\n• Import all channel members from Slack\n• Match Harvest accounts by email",
						},
					},
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "✓ Run sync", emoji: true },
								action_id: "admin_sync_confirm",
								style: "primary",
							},
							{
								type: "button",
								text: { type: "plain_text", text: "✗ Cancel", emoji: true },
								action_id: "admin_sync_cancel",
								style: "danger",
							},
						],
					},
				],
				threadTs: msg.threadTs ?? msg.ts,
			});

			return null;
		});

		// Handle confirm
		ctx.slack.onAction(/^admin_sync_confirm$/, async (event) => {
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: "⏳ Syncing users…",
				blocks: [{ type: "section", text: { type: "mrkdwn", text: "⏳ *Syncing users…*" } }],
			});

			try {
				const result = await syncUsers(this.db, ctx, channelId);
				const lines = [
					"✅ *User sync complete*",
					`• Imported: ${result.imported}`,
					`• Updated: ${result.updated}`,
					`• Skipped: ${result.skipped} (bots/deactivated)`,
					`• Harvest linked: ${result.harvestLinked}`,
				];
				if (result.errors.length > 0) {
					lines.push(`• Errors: ${result.errors.length}`);
					for (const err of result.errors.slice(0, 3)) {
						lines.push(`  – ${err}`);
					}
				}
				await ctx.slack.updateMessage(event.channelId, event.messageTs, {
					text: lines.join("\n"),
					blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await ctx.slack.updateMessage(event.channelId, event.messageTs, {
					text: `❌ Sync failed: ${msg}`,
					blocks: [{ type: "section", text: { type: "mrkdwn", text: `❌ *Sync failed:* ${msg}` } }],
				});
			}
		});

		// Handle cancel
		ctx.slack.onAction(/^admin_sync_cancel$/, async (event) => {
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: "Sync cancelled.",
				blocks: [{ type: "section", text: { type: "mrkdwn", text: "🚫 *Sync cancelled.*" } }],
			});
		});
	}
}

// ─── Sync logic ────────────────────────────────────────

interface SyncResult {
	imported: number;
	updated: number;
	skipped: number;
	harvestLinked: number;
	errors: string[];
}

async function syncUsers(db: Database, ctx: BotContext, channelId: string): Promise<SyncResult> {
	const result: SyncResult = { imported: 0, updated: 0, skipped: 0, harvestLinked: 0, errors: [] };

	// 1. Import Slack channel members
	const memberIds = await ctx.slack.getChannelMembers(channelId);
	console.log(`[admin] found ${memberIds.length} channel members`);

	for (const slackId of memberIds) {
		try {
			const info = await ctx.slack.getUserInfo(slackId);
			if (info.isBot) {
				result.skipped++;
				continue;
			}

			const existing = getUserBySlackId(db, slackId);
			if (existing) {
				updateUser(db, existing.id, {
					slackDisplayName: info.displayName,
					email: info.email ?? null,
					slackTimezone: info.timezone,
				});
				result.updated++;
			} else {
				createUser(db, {
					slackUserId: slackId,
					slackDisplayName: info.displayName,
					email: info.email ?? null,
					slackTimezone: info.timezone,
				});
				result.imported++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.errors.push(`Slack user ${slackId}: ${msg}`);
			result.skipped++;
		}
	}

	// 2. Link Harvest accounts by email
	try {
		const harvestUsers = await ctx.harvest.getUsers();
		const emailToHarvestId = new Map<string, number>();
		for (const hu of harvestUsers) {
			if (hu.email) {
				emailToHarvestId.set(hu.email.toLowerCase(), hu.id);
			}
		}

		const allUsers = listUsers(db, { activeOnly: true });
		for (const user of allUsers) {
			if (!user.email) continue;
			const harvestId = emailToHarvestId.get(user.email.toLowerCase());
			if (harvestId && user.harvest_user_id !== harvestId) {
				updateUser(db, user.id, { harvestUserId: harvestId });
				result.harvestLinked++;
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		result.errors.push(`Harvest link: ${msg}`);
	}

	console.log(`[admin] sync done: ${JSON.stringify(result)}`);
	return result;
}
