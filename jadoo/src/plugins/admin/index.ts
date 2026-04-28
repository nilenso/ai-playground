/**
 * Admin plugin — provides a `/jadoo-sync` slash command for importing Slack
 * channel members and linking their Harvest accounts by email.
 *
 * The slash command responds ephemerally so only the invoker sees the sync
 * output. This avoids noisy visible admin messages in the leave channel.
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

		ctx.slack.onCommand("/jadoo-sync", async (event) => {
			if (event.channelId !== channelId) {
				await event.respond({
					text: `⚠️ Please run /jadoo-sync in the configured leave channel (<#${channelId}>).`,
				});
				return;
			}

			await event.respond({
				text: "⏳ Syncing users from Slack and Harvest…",
			});

			try {
				const result = await syncUsers(this.db, ctx, channelId);
				const summary = formatSyncResult(result);
				await event.respond({
					text: summary,
					blocks: [{ type: "section", text: { type: "mrkdwn", text: summary } }],
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await event.respond({
					text: `❌ Sync failed: ${msg}`,
					blocks: [{ type: "section", text: { type: "mrkdwn", text: `❌ *Sync failed:* ${msg}` } }],
				});
			}
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

function formatSyncResult(result: SyncResult): string {
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

	return lines.join("\n");
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
