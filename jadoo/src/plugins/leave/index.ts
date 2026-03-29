import type { Database } from "bun:sqlite";
import type { BotContext, Plugin } from "../../interfaces/plugin.js";
import type { PluginConfigSchema } from "../../config/plugin-config.js";
import { ParsedLeaveSchema } from "./schema.js";
import {
	buildConfirmationBlocks,
	buildCancellationClarificationBlocks,
	buildCancellationConfirmationBlocks,
} from "./blocks.js";
import { getUserBySlackId, createUser } from "../../db/users.js";
import {
	createPendingAction,
	updatePendingActionStatus,
	expirePendingActions,
	updatePendingActionBotMessageTs,
	getPendingActionsForThread,
} from "../../db/pending-actions.js";
import { getLeaveRecordsByUserAndDates } from "../../db/leave-records.js";

function getFutureExpiry(): string {
	const date = new Date();
	date.setHours(date.getHours() + 1); // 1 hour expiry
	return date.toISOString();
}

export class LeavePlugin implements Plugin {
	readonly name = "leave";
	readonly configSchema: PluginConfigSchema = {
		channelId: {
			envVar: "SLACK_LEAVE_CHANNEL_ID",
			description: "Channel ID to monitor for leave requests",
			required: true,
		},
		keywords: { envVar: "TRIGGER_KEYWORDS", default: "leave,vacation,sick,off" },
	};

	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	async init(ctx: BotContext, config: Record<string, any>) {
		const targetChannelId = config.channelId as string;
		const triggerKeywords = (config.keywords as string).split(",").map((k) => k.trim().toLowerCase());

		ctx.slack.onMessage(async (msg) => {
			if (msg.botId) return null;
			if (msg.channelId !== targetChannelId) return null;

			// Check for trigger keywords if it's a new message. If it's a thread reply, we might want to process it anyway
			// to handle clarification responses.
			const lowerText = msg.text.toLowerCase();
			const hasKeyword = triggerKeywords.some((kw) => lowerText.includes(kw));

			// If it doesn't have a keyword and it's not a thread reply, ignore it.
			if (!hasKeyword && !msg.threadTs) return null;

			// Look up user
			let user = getUserBySlackId(this.db, msg.userId);
			if (!user) {
				const userInfo = await ctx.slack.getUserInfo(msg.userId);
				user = createUser(this.db, {
					slackUserId: msg.userId,
					slackDisplayName: userInfo.displayName,
					email: userInfo.email,
					slackTimezone: userInfo.timezone,
				});
			}

			// Include thread history if applicable
			let threadContext = "";
			if (msg.threadTs) {
				const replies = await ctx.slack.getThreadReplies(msg.channelId, msg.threadTs);
				threadContext = replies.map((r) => `${r.userId === msg.userId ? "User" : "Bot"}: ${r.text}`).join("\n");
			}

			const systemPrompt = `You are a helpful assistant that parses leave requests and cancellations.
Extract the leave dates, type, and category.
If the user is cancelling leave, set is_cancellation to true.
If the message is not a leave request or cancellation, set is_leave_request to false.
The current date is ${new Date().toISOString().split("T")[0]}.
The user's timezone is ${user.slack_timezone}.
${threadContext ? `Previous thread context:\n${threadContext}` : ""}`;

			const parsed = await ctx.ai.completeStructured(
				{
					systemPrompt,
					messages: [{ role: "user", content: msg.text }],
				},
				ParsedLeaveSchema,
			);

			if (!parsed.is_leave_request && !parsed.is_cancellation) {
				return null;
			}

			if (parsed.confidence === "low") {
				return `I'm not quite sure I understood that. Could you clarify your leave request? (Note: ${parsed.ambiguity_notes})`;
			}

			// Handle cancellation
			if (parsed.is_cancellation) {
				if (parsed.dates.length === 0) {
					// Ask for clarification
					const sent = await ctx.slack.postMessage(msg.channelId, {
						blocks: buildCancellationClarificationBlocks(),
						threadTs: msg.threadTs || msg.ts,
					});
					return null;
				}

				// We have dates to cancel
				const dates = parsed.dates.map((d) => d.date);
				const action = createPendingAction(this.db, {
					userId: user.id,
					actionType: "cancel_leave",
					payload: { dates },
					slackMessageTs: msg.ts,
					slackChannelId: msg.channelId,
					slackThreadTs: msg.threadTs,
					expiresAt: getFutureExpiry(),
				});

				const sent = await ctx.slack.postMessage(msg.channelId, {
					blocks: buildCancellationConfirmationBlocks(parsed.dates, action.id),
					threadTs: msg.threadTs || msg.ts,
				});

				updatePendingActionBotMessageTs(this.db, action.id, sent.ts);
				return null;
			}

			// Handle leave request
			if (parsed.dates.length === 0) {
				return "I understood this is a leave request, but couldn't find specific dates. Could you clarify?";
			}

			// Supersede existing pending actions in this thread
			if (msg.threadTs) {
				const existing = getPendingActionsForThread(this.db, user.id, msg.channelId, msg.threadTs);
				for (const act of existing) {
					updatePendingActionStatus(this.db, act.id, "expired");
					if (act.slack_bot_message_ts) {
						await ctx.slack.updateMessage(msg.channelId, act.slack_bot_message_ts, {
							text: "↩️ This request was superseded by a newer one below.",
							blocks: [
								{
									type: "section",
									text: { type: "mrkdwn", text: "↩️ _This request was superseded by a newer one below._" },
								},
							],
						});
					}
				}
			}

			const dateStrings = parsed.dates.map((d) => d.date);
			const existingRecords = getLeaveRecordsByUserAndDates(this.db, user.id, dateStrings);
			const hasConflict = existingRecords.length > 0;

			const action = createPendingAction(this.db, {
				userId: user.id,
				actionType: "create_leave",
				payload: {
					dates: dateStrings,
					leaveType: parsed.dates[0].type, // In v1 we assume all dates in a request have the same type/category
					category: parsed.dates[0].category,
					reason: parsed.original_text_summary,
				},
				slackMessageTs: msg.ts,
				slackChannelId: msg.channelId,
				slackThreadTs: msg.threadTs,
				expiresAt: getFutureExpiry(),
			});

			const blocks = buildConfirmationBlocks(parsed.dates, action.id, hasConflict);
			const sent = await ctx.slack.postMessage(msg.channelId, {
				blocks,
				threadTs: msg.threadTs || msg.ts,
			});

			updatePendingActionBotMessageTs(this.db, action.id, sent.ts);
			return null;
		});

		ctx.slack.onAction(/^leave_confirm$/, async (event) => {
			const actionId = event.value;
			updatePendingActionStatus(this.db, actionId, "confirmed");
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: "⏳ Processing your leave request...",
				blocks: [
					{
						type: "section",
						text: { type: "mrkdwn", text: "⏳ *Processing your leave request...*" },
					},
				],
			});
		});

		ctx.slack.onAction(/^leave_cancel$/, async (event) => {
			const actionId = event.value;
			updatePendingActionStatus(this.db, actionId, "cancelled");
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: "❌ Leave request cancelled.",
				blocks: [
					{
						type: "section",
						text: { type: "mrkdwn", text: "❌ *Leave request cancelled.*" },
					},
				],
			});
		});

		ctx.slack.onAction(/^leave_confirm_cancel$/, async (event) => {
			const actionId = event.value;
			updatePendingActionStatus(this.db, actionId, "confirmed"); // "confirmed" means worker should process the cancellation
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: "⏳ Processing cancellation...",
				blocks: [
					{
						type: "section",
						text: { type: "mrkdwn", text: "⏳ *Processing cancellation...*" },
					},
				],
			});
		});

		ctx.slack.onAction(/^leave_abort_cancel$/, async (event) => {
			const actionId = event.value;
			updatePendingActionStatus(this.db, actionId, "cancelled");
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: "✅ Kept leave as is.",
				blocks: [
					{
						type: "section",
						text: { type: "mrkdwn", text: "✅ *Kept leave as is.*" },
					},
				],
			});
		});
	}
}
