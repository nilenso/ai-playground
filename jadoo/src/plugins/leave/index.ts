import type { Database } from "bun:sqlite";
import type { PluginConfig, PluginConfigSchema } from "../../config/plugin-config.js";
import { getLeaveRecordsByUserAndDates } from "../../db/leave-records.js";
import {
	createPendingAction,
	getPendingActionsForThread,
	updatePendingActionBotMessageTs,
	updatePendingActionStatus,
} from "../../db/pending-actions.js";
import { createUser, getUserBySlackId } from "../../db/users.js";
import type { BotContext, Plugin } from "../../interfaces/plugin.js";
import {
	buildCancellationClarificationBlocks,
	buildCancellationConfirmationBlocks,
	buildConfirmationBlocks,
} from "./blocks.js";
import { ParsedLeaveSchema } from "./schema.js";

function getFutureExpiry(): string {
	const date = new Date();
	date.setHours(date.getHours() + 1); // 1 hour expiry
	return date.toISOString();
}

function logLeave(message: string, details?: Record<string, unknown>): void {
	console.log(`[leave] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

function isEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
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
		debugLogAllMessages: {
			envVar: "LEAVE_DEBUG_LOG_ALL_MESSAGES",
			description: "When true, log every Slack message with whether it matched as an OOO/leave message",
			default: "false",
		},
	};

	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	async init(ctx: BotContext, config: PluginConfig) {
		const targetChannelId = config.channelId as string;
		const triggerKeywords = (config.keywords as string).split(",").map((k) => k.trim().toLowerCase());
		const debugLogAllMessages = isEnabled(config.debugLogAllMessages);

		logLeave("initialized leave plugin listener", {
			targetChannelId,
			triggerKeywords,
			debugLogAllMessages,
		});

		ctx.slack.onMessage(async (msg) => {
			if (msg.botId) {
				if (debugLogAllMessages) {
					logLeave("ignoring bot message", {
						channelId: msg.channelId,
						userId: msg.userId,
						ts: msg.ts,
						threadTs: msg.threadTs ?? null,
						text: msg.text,
					});
				}
				return null;
			}

			// Check for trigger keywords if it's a new message. If it's a thread reply, we might want to process it anyway
			// to handle clarification responses.
			const lowerText = msg.text.toLowerCase();
			const hasKeyword = triggerKeywords.some((kw) => lowerText.includes(kw));
			const isTargetChannel = msg.channelId === targetChannelId;
			const isThreadReply = Boolean(msg.threadTs);
			const matchedAsOooMessage = isTargetChannel && (hasKeyword || isThreadReply);

			if (debugLogAllMessages) {
				logLeave("ooo message match evaluation", {
					channelId: msg.channelId,
					targetChannelId,
					userId: msg.userId,
					ts: msg.ts,
					threadTs: msg.threadTs ?? null,
					isTargetChannel,
					hasKeyword,
					isThreadReply,
					matchedAsOooMessage,
					text: msg.text,
				});
			}

			if (!isTargetChannel) {
				if (debugLogAllMessages) {
					logLeave("message did not match as ooo message", {
						channelId: msg.channelId,
						targetChannelId,
						userId: msg.userId,
						ts: msg.ts,
						reason: "different_channel",
						matchedAsOooMessage,
						text: msg.text,
					});
				}
				return null;
			}

			// If it doesn't have a keyword and it's not a thread reply, ignore it.
			if (!hasKeyword && !msg.threadTs) {
				if (debugLogAllMessages) {
					logLeave("message did not match as ooo message", {
						channelId: msg.channelId,
						userId: msg.userId,
						ts: msg.ts,
						reason: "missing_keyword_and_not_thread_reply",
						hasKeyword,
						isThreadReply,
						matchedAsOooMessage,
						text: msg.text,
					});
				}
				return null;
			}

			logLeave("message matched as ooo message", {
				channelId: msg.channelId,
				userId: msg.userId,
				ts: msg.ts,
				threadTs: msg.threadTs ?? null,
				hasKeyword,
				isThreadReply,
				matchedAsOooMessage,
				text: msg.text,
			});

			// Look up user
			let user = getUserBySlackId(this.db, msg.userId);
			if (!user) {
				logLeave("user not found locally; fetching from Slack", { userId: msg.userId });
				const userInfo = await ctx.slack.getUserInfo(msg.userId);
				user = createUser(this.db, {
					slackUserId: msg.userId,
					slackDisplayName: userInfo.displayName,
					email: userInfo.email,
					slackTimezone: userInfo.timezone,
				});
				logLeave("created local user", {
					userId: msg.userId,
					userDbId: user.id,
					displayName: user.slack_display_name,
					timezone: user.slack_timezone,
				});
			} else {
				logLeave("found local user", {
					userId: msg.userId,
					userDbId: user.id,
					displayName: user.slack_display_name,
					timezone: user.slack_timezone,
				});
			}

			// Include thread history if applicable
			let threadContext = "";
			if (msg.threadTs) {
				const replies = await ctx.slack.getThreadReplies(msg.channelId, msg.threadTs);
				threadContext = replies.map((r) => `${r.userId === msg.userId ? "User" : "Bot"}: ${r.text}`).join("\n");
				logLeave("loaded thread context", {
					channelId: msg.channelId,
					threadTs: msg.threadTs,
					replyCount: replies.length,
				});
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

			logLeave("parsed leave message", {
				channelId: msg.channelId,
				userId: msg.userId,
				ts: msg.ts,
				threadTs: msg.threadTs ?? null,
				parsed,
			});

			if (!parsed.is_leave_request && !parsed.is_cancellation) {
				logLeave("parser decided message is not a leave request", {
					channelId: msg.channelId,
					userId: msg.userId,
					ts: msg.ts,
					text: msg.text,
				});
				return null;
			}

			if (parsed.confidence === "low") {
				logLeave("parser returned low confidence", {
					channelId: msg.channelId,
					userId: msg.userId,
					ts: msg.ts,
					ambiguityNotes: parsed.ambiguity_notes,
					parsed,
				});
				return `I'm not quite sure I understood that. Could you clarify your leave request? (Note: ${parsed.ambiguity_notes})`;
			}

			// Handle cancellation
			if (parsed.is_cancellation) {
				if (parsed.dates.length === 0) {
					logLeave("cancellation request needs clarification", {
						channelId: msg.channelId,
						userId: msg.userId,
						ts: msg.ts,
						threadTs: msg.threadTs ?? msg.ts,
					});
					await ctx.slack.postMessage(msg.channelId, {
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
				logLeave("created pending cancellation action", {
					actionId: action.id,
					userDbId: user.id,
					userId: msg.userId,
					dates,
					channelId: msg.channelId,
					messageTs: msg.ts,
					threadTs: msg.threadTs ?? null,
					expiresAt: action.expires_at,
				});

				const sent = await ctx.slack.postMessage(msg.channelId, {
					blocks: buildCancellationConfirmationBlocks(parsed.dates, action.id),
					threadTs: msg.threadTs || msg.ts,
				});

				updatePendingActionBotMessageTs(this.db, action.id, sent.ts);
				logLeave("posted cancellation confirmation message", {
					actionId: action.id,
					channelId: msg.channelId,
					botMessageTs: sent.ts,
					threadTs: msg.threadTs ?? msg.ts,
				});
				return null;
			}

			// Handle leave request
			if (parsed.dates.length === 0) {
				logLeave("leave request had no parsed dates", {
					channelId: msg.channelId,
					userId: msg.userId,
					ts: msg.ts,
					parsed,
				});
				return "I understood this is a leave request, but couldn't find specific dates. Could you clarify?";
			}

			// Supersede existing pending actions in this thread
			if (msg.threadTs) {
				const existing = getPendingActionsForThread(this.db, user.id, msg.channelId, msg.threadTs);
				if (existing.length > 0) {
					logLeave("superseding existing pending actions in thread", {
						userDbId: user.id,
						channelId: msg.channelId,
						threadTs: msg.threadTs,
						actionIds: existing.map((act) => act.id),
					});
				}
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
			logLeave("checked existing leave records", {
				userDbId: user.id,
				channelId: msg.channelId,
				requestedDates: dateStrings,
				hasConflict,
				existingRecordDates: existingRecords.map((record) => record.date),
			});

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
			logLeave("created pending leave action", {
				actionId: action.id,
				userDbId: user.id,
				userId: msg.userId,
				channelId: msg.channelId,
				messageTs: msg.ts,
				threadTs: msg.threadTs ?? null,
				payload: JSON.parse(action.payload),
				expiresAt: action.expires_at,
			});

			const blocks = buildConfirmationBlocks(parsed.dates, action.id, hasConflict);
			const sent = await ctx.slack.postMessage(msg.channelId, {
				blocks,
				threadTs: msg.threadTs || msg.ts,
			});

			updatePendingActionBotMessageTs(this.db, action.id, sent.ts);
			logLeave("posted leave confirmation message", {
				actionId: action.id,
				channelId: msg.channelId,
				botMessageTs: sent.ts,
				threadTs: msg.threadTs ?? msg.ts,
			});
			return null;
		});

		ctx.slack.onAction(/^leave_confirm$/, async (event) => {
			const actionId = event.value;
			logLeave("leave confirmation clicked", {
				actionId,
				userId: event.userId,
				channelId: event.channelId,
				messageTs: event.messageTs,
				threadTs: event.threadTs ?? null,
			});
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
			logLeave("leave action marked confirmed", {
				actionId,
				channelId: event.channelId,
				messageTs: event.messageTs,
			});
		});

		ctx.slack.onAction(/^leave_cancel$/, async (event) => {
			const actionId = event.value;
			logLeave("leave request cancelled from confirmation prompt", {
				actionId,
				userId: event.userId,
				channelId: event.channelId,
				messageTs: event.messageTs,
				threadTs: event.threadTs ?? null,
			});
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
			logLeave("leave cancellation confirmed", {
				actionId,
				userId: event.userId,
				channelId: event.channelId,
				messageTs: event.messageTs,
				threadTs: event.threadTs ?? null,
			});
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
			logLeave("cancellation action marked confirmed", {
				actionId,
				channelId: event.channelId,
				messageTs: event.messageTs,
			});
		});

		ctx.slack.onAction(/^leave_abort_cancel$/, async (event) => {
			const actionId = event.value;
			logLeave("leave cancellation aborted", {
				actionId,
				userId: event.userId,
				channelId: event.channelId,
				messageTs: event.messageTs,
				threadTs: event.threadTs ?? null,
			});
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
