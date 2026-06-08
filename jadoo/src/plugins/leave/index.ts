import type { Database } from "bun:sqlite";
import type { Static } from "@sinclair/typebox";
import type { PluginConfig, PluginConfigSchema } from "../../config/plugin-config.js";
import { getCancelableLeaveRecordsByUser, getLeaveRecordsByUserAndDates } from "../../db/leave-records.js";
import {
	createPendingAction,
	getPendingActionsForThread,
	updatePendingActionBotMessageTs,
	updatePendingActionStatus,
} from "../../db/pending-actions.js";
import { createUser, getUserBySlackId } from "../../db/users.js";
import type { BotContext, Plugin } from "../../interfaces/plugin.js";
import {
	buildCancellationConfirmationBlocks,
	buildCancellationSelectionBlocks,
	buildConfirmationBlocks,
	buildInteractiveChoiceBlocks,
	buildLeaveOptionsBlocks,
	formatLeaveDateLabel,
	formatLeaveDateRangeLabel,
	type InteractiveOption,
} from "./blocks.js";
import { ParsedLeaveSchema } from "./schema.js";

function getFutureExpiry(): string {
	const date = new Date();
	date.setHours(date.getHours() + 1);
	return date.toISOString();
}

function logLeave(message: string, details?: Record<string, unknown>): void {
	console.log(`[leave] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

function isEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

type ParsedLeave = Static<typeof ParsedLeaveSchema>;
type LeaveType = "full" | "half_am" | "half_pm" | "specific";
type LeaveCategory = "vacation" | "sick";

interface CreateSelectionPayload {
	kind: "create";
	dates: string[];
	leaveType: LeaveType;
	startTime?: string;
	endTime?: string;
	category: LeaveCategory;
	reason: string;
	sourceMessageTs: string;
	sourceThreadTs?: string;
}

interface CancelSelectionPayload {
	kind: "cancel";
	dates: string[];
	sourceMessageTs: string;
	sourceThreadTs?: string;
}

interface DismissSelectionPayload {
	kind: "dismiss";
	message: string;
}

type SelectionPayload = CreateSelectionPayload | CancelSelectionPayload | DismissSelectionPayload;

function encodeSelectionPayload(payload: SelectionPayload): string {
	return JSON.stringify(payload);
}

function decodeSelectionPayload(value: string): SelectionPayload | null {
	try {
		return JSON.parse(value) as SelectionPayload;
	} catch {
		return null;
	}
}

function getDatePartsInTimeZone(now: Date, timeZone: string): { year: number; month: number; day: number } {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = formatter.formatToParts(now);
	const get = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value ?? "0");
	return { year: get("year"), month: get("month"), day: get("day") };
}

function formatYmd(year: number, month: number, day: number): string {
	return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function localDateStringInTimeZone(timeZone: string, now: Date = new Date()): string {
	const { year, month, day } = getDatePartsInTimeZone(now, timeZone || "UTC");
	return formatYmd(year, month, day);
}

function addDays(dateText: string, days: number): string {
	const [year, month, day] = dateText.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + days);
	return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getWeekday(dateText: string): number {
	const [year, month, day] = dateText.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextWeekday(dateText: string, targetWeekday: number, forceFollowingWeek: boolean): string {
	const currentWeekday = getWeekday(dateText);
	let diff = (targetWeekday - currentWeekday + 7) % 7;
	if (diff === 0) diff = 7;
	if (forceFollowingWeek && diff < 7) diff += 7;
	return addDays(dateText, diff);
}

function weekdaySpan(dateText: string, startWeekday: number, endWeekday: number): string[] {
	const dates: string[] = [];
	let cursor = dateText;
	while (getWeekday(cursor) !== startWeekday) {
		cursor = addDays(cursor, 1);
	}
	while (getWeekday(cursor) <= endWeekday) {
		dates.push(cursor);
		cursor = addDays(cursor, 1);
	}
	return dates;
}

function inferLeaveType(text: string): LeaveType {
	const lowerText = text.toLowerCase();
	if (lowerText.includes("first half") || lowerText.includes("morning") || lowerText.includes("half day first")) {
		return "half_am";
	}
	if (lowerText.includes("second half") || lowerText.includes("afternoon") || lowerText.includes("half day second")) {
		return "half_pm";
	}
	return "full";
}

function inferLeaveCategory(text: string): LeaveCategory {
	const lowerText = text.toLowerCase();
	if (/\b(sick|fever|ill|unwell|doctor|medical)\b/.test(lowerText)) {
		return "sick";
	}
	return "vacation";
}

function isSpecificLeaveMissingTime(leaveType?: LeaveType, startTime?: string, endTime?: string): boolean {
	return leaveType === "specific" && (!startTime || !endTime);
}

function parseTimeToMinutes(time: string): number {
	const match = /^(\d{2}):(\d{2})$/.exec(time);
	if (!match) return Number.NaN;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return Number.NaN;
	return hours * 60 + minutes;
}

function formatMinutesAsTime(totalMinutes: number): string {
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function buildSpecificLeaveTimeRanges(
	startTime?: string,
	endTime?: string,
): Array<{ startTime: string; endTime: string }> {
	const options: Array<{ startTime: string; endTime: string }> = [];
	const durations = [120, 180, 240];

	if (startTime && !endTime) {
		const startMinutes = parseTimeToMinutes(startTime);
		if (!Number.isNaN(startMinutes)) {
			for (const duration of durations) {
				const candidateEnd = startMinutes + duration;
				if (candidateEnd < 24 * 60) {
					options.push({ startTime, endTime: formatMinutesAsTime(candidateEnd) });
				}
			}
		}
	}

	if (!startTime && endTime) {
		const endMinutes = parseTimeToMinutes(endTime);
		if (!Number.isNaN(endMinutes)) {
			for (const duration of durations) {
				const candidateStart = endMinutes - duration;
				if (candidateStart >= 0) {
					options.push({ startTime: formatMinutesAsTime(candidateStart), endTime });
				}
			}
		}
	}

	return options;
}

function inferFallbackDateOptions(text: string, timeZone: string): string[][] {
	const lowerText = text.toLowerCase();
	const today = localDateStringInTimeZone(timeZone);
	const options: string[][] = [];

	if (lowerText.includes("day after tomorrow")) {
		options.push([addDays(today, 2)]);
	}
	if (lowerText.includes("tomorrow")) {
		options.push([addDays(today, 1)]);
	}
	if (lowerText.includes("today")) {
		options.push([today]);
	}
	if (lowerText.includes("next week")) {
		options.push(weekdaySpan(addDays(today, 1), 1, 5));
	}
	if (lowerText.includes("this week")) {
		const thisWeek = weekdaySpan(today, Math.max(getWeekday(today), 1), 5).filter((date) => getWeekday(date) >= 1);
		if (thisWeek.length > 0) {
			options.push(thisWeek);
		}
	}

	const weekdayMatches: Array<{ name: string; index: number }> = [
		{ name: "sunday", index: 0 },
		{ name: "monday", index: 1 },
		{ name: "tuesday", index: 2 },
		{ name: "wednesday", index: 3 },
		{ name: "thursday", index: 4 },
		{ name: "friday", index: 5 },
		{ name: "saturday", index: 6 },
	];

	for (const weekday of weekdayMatches) {
		if (lowerText.includes(weekday.name)) {
			options.push([nextWeekday(today, weekday.index, lowerText.includes(`next ${weekday.name}`))]);
		}
	}

	if (options.length === 0) {
		options.push([today], [addDays(today, 1)]);
	}

	const seen = new Set<string>();
	return options.filter((dates) => {
		if (dates.length === 0) return false;
		const key = dates.join(",");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function getThreadAnchor(sourceMessageTs: string, sourceThreadTs?: string): string {
	return sourceThreadTs ?? sourceMessageTs;
}

function toLeaveDates(
	dates: string[],
	leaveType: LeaveType,
	category: LeaveCategory,
	startTime?: string,
	endTime?: string,
) {
	return dates.map((date) => ({
		date,
		type: leaveType,
		...(leaveType === "specific" ? { start_time: startTime, end_time: endTime } : {}),
		category,
	}));
}

function buildCreateSelectionOptions(
	messageText: string,
	parsed: ParsedLeave,
	timeZone: string,
	sourceMessageTs: string,
	sourceThreadTs?: string,
): InteractiveOption[] {
	const leaveType = parsed.dates[0]?.type ?? inferLeaveType(messageText);
	const startTime = parsed.dates[0]?.start_time;
	const endTime = parsed.dates[0]?.end_time;
	const category = parsed.dates[0]?.category ?? inferLeaveCategory(messageText);
	const optionDates: string[][] = [];

	if (parsed.dates.length > 0) {
		optionDates.push(parsed.dates.map((date) => date.date));
	}
	optionDates.push(...inferFallbackDateOptions(messageText, timeZone));

	const seenDates = new Set<string>();
	const uniqueDates = optionDates.filter((dates) => {
		if (dates.length === 0) return false;
		const key = dates.join(",");
		if (seenDates.has(key)) return false;
		seenDates.add(key);
		return true;
	});

	const options: InteractiveOption[] = [];
	if (isSpecificLeaveMissingTime(leaveType, startTime, endTime)) {
		const timeRanges = buildSpecificLeaveTimeRanges(startTime, endTime);
		for (const dates of uniqueDates) {
			for (const range of timeRanges) {
				options.push({
					text: `Use ${formatLeaveDateRangeLabel(dates)} ${range.startTime}-${range.endTime}`,
					value: encodeSelectionPayload({
						kind: "create",
						dates,
						leaveType,
						startTime: range.startTime,
						endTime: range.endTime,
						category,
						reason: parsed.original_text_summary || messageText,
						sourceMessageTs,
						sourceThreadTs,
					}),
					actionId: "leave_select_create_option",
					style: "primary",
				});
				if (options.length === 4) break;
			}
			if (options.length === 4) break;
		}
	} else {
		for (const dates of uniqueDates) {
			options.push({
				text: `Use ${formatLeaveDateRangeLabel(dates)}`,
				value: encodeSelectionPayload({
					kind: "create",
					dates,
					leaveType,
					startTime,
					endTime,
					category,
					reason: parsed.original_text_summary || messageText,
					sourceMessageTs,
					sourceThreadTs,
				}),
				actionId: "leave_select_create_option",
				style: "primary",
			});
			if (options.length === 4) break;
		}
	}

	options.push({
		text: "✗ Cancel request",
		value: encodeSelectionPayload({ kind: "dismiss", message: "❌ Leave request cancelled." }),
		actionId: "leave_dismiss_option",
		style: "danger",
	});

	return options;
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
		const triggerKeywords = (config.keywords as string).split(",").map((keyword) => keyword.trim().toLowerCase());
		const debugLogAllMessages = isEnabled(config.debugLogAllMessages);

		logLeave("initialized leave plugin listener", {
			targetChannelId,
			triggerKeywords,
			debugLogAllMessages,
		});

		const supersedePendingActionsForThread = async (
			userId: number,
			channelId: string,
			threadAnchor: string,
			messageToKeepTs?: string,
		) => {
			const existing = getPendingActionsForThread(this.db, userId, channelId, threadAnchor);
			const staleActions = existing.filter((action) => action.slack_bot_message_ts !== messageToKeepTs);
			if (staleActions.length > 0) {
				logLeave("superseding existing pending actions in thread", {
					userDbId: userId,
					channelId,
					threadTs: threadAnchor,
					actionIds: staleActions.map((action) => action.id),
				});
			}

			for (const action of staleActions) {
				updatePendingActionStatus(this.db, action.id, "expired");
				if (action.slack_bot_message_ts) {
					await ctx.slack.updateMessage(channelId, action.slack_bot_message_ts, {
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
		};

		const presentLeaveOptions = async (params: {
			channelId: string;
			sourceMessageTs: string;
			sourceThreadTs?: string;
			messageText: string;
			parsed: ParsedLeave;
			timeZone: string;
			replaceMessageTs?: string;
		}) => {
			const options = buildCreateSelectionOptions(
				params.messageText,
				params.parsed,
				params.timeZone,
				params.sourceMessageTs,
				params.sourceThreadTs,
			);
			const blocks = buildLeaveOptionsBlocks(options);
			if (params.replaceMessageTs) {
				await ctx.slack.updateMessage(params.channelId, params.replaceMessageTs, {
					text: "🧭 Choose one of the leave options.",
					blocks,
				});
			} else {
				await ctx.slack.postMessage(params.channelId, {
					text: "🧭 Choose one of the leave options.",
					blocks,
					threadTs: getThreadAnchor(params.sourceMessageTs, params.sourceThreadTs),
				});
			}
		};

		const showLeaveConfirmation = async (params: {
			userDbId: number;
			slackUserId: string;
			channelId: string;
			sourceMessageTs: string;
			sourceThreadTs?: string;
			dates: string[];
			leaveType: LeaveType;
			startTime?: string;
			endTime?: string;
			category: LeaveCategory;
			reason: string;
			replaceMessageTs?: string;
		}) => {
			const threadAnchor = getThreadAnchor(params.sourceMessageTs, params.sourceThreadTs);
			await supersedePendingActionsForThread(params.userDbId, params.channelId, threadAnchor, params.replaceMessageTs);

			const existingRecords = getLeaveRecordsByUserAndDates(this.db, params.userDbId, params.dates);
			const hasConflict = existingRecords.length > 0;
			logLeave("checked existing leave records", {
				userDbId: params.userDbId,
				channelId: params.channelId,
				requestedDates: params.dates,
				hasConflict,
				existingRecordDates: existingRecords.map((record) => record.date),
			});

			const action = createPendingAction(this.db, {
				userId: params.userDbId,
				actionType: "create_leave",
				payload: {
					dates: params.dates,
					leaveType: params.leaveType,
					startTime: params.startTime,
					endTime: params.endTime,
					category: params.category,
					reason: params.reason,
				},
				slackMessageTs: params.sourceMessageTs,
				slackChannelId: params.channelId,
				slackThreadTs: params.sourceThreadTs,
				expiresAt: getFutureExpiry(),
			});
			logLeave("created pending leave action", {
				actionId: action.id,
				userDbId: params.userDbId,
				userId: params.slackUserId,
				channelId: params.channelId,
				messageTs: params.sourceMessageTs,
				threadTs: params.sourceThreadTs ?? null,
				payload: JSON.parse(action.payload),
				expiresAt: action.expires_at,
			});

			const blocks = buildConfirmationBlocks(
				toLeaveDates(params.dates, params.leaveType, params.category, params.startTime, params.endTime),
				action.id,
				hasConflict,
			);
			if (params.replaceMessageTs) {
				updatePendingActionBotMessageTs(this.db, action.id, params.replaceMessageTs);
				await ctx.slack.updateMessage(params.channelId, params.replaceMessageTs, {
					text: "📅 Leave request ready for confirmation.",
					blocks,
				});
				logLeave("updated leave option message to confirmation prompt", {
					actionId: action.id,
					channelId: params.channelId,
					botMessageTs: params.replaceMessageTs,
				});
				return;
			}

			const sent = await ctx.slack.postMessage(params.channelId, {
				text: "📅 Leave request ready for confirmation.",
				blocks,
				threadTs: threadAnchor,
			});
			updatePendingActionBotMessageTs(this.db, action.id, sent.ts);
			logLeave("posted leave confirmation message", {
				actionId: action.id,
				channelId: params.channelId,
				botMessageTs: sent.ts,
				threadTs: threadAnchor,
			});
		};

		const showCancellationConfirmation = async (params: {
			userDbId: number;
			slackUserId: string;
			channelId: string;
			sourceMessageTs: string;
			sourceThreadTs?: string;
			dates: string[];
			replaceMessageTs?: string;
		}) => {
			const action = createPendingAction(this.db, {
				userId: params.userDbId,
				actionType: "cancel_leave",
				payload: { dates: params.dates },
				slackMessageTs: params.sourceMessageTs,
				slackChannelId: params.channelId,
				slackThreadTs: params.sourceThreadTs,
				expiresAt: getFutureExpiry(),
			});
			logLeave("created pending cancellation action", {
				actionId: action.id,
				userDbId: params.userDbId,
				userId: params.slackUserId,
				dates: params.dates,
				channelId: params.channelId,
				messageTs: params.sourceMessageTs,
				threadTs: params.sourceThreadTs ?? null,
				expiresAt: action.expires_at,
			});

			const blocks = buildCancellationConfirmationBlocks(
				params.dates.map((date) => ({ date, type: "full", category: "vacation" })),
				action.id,
			);
			if (params.replaceMessageTs) {
				updatePendingActionBotMessageTs(this.db, action.id, params.replaceMessageTs);
				await ctx.slack.updateMessage(params.channelId, params.replaceMessageTs, {
					text: "🔄 Leave cancellation ready for confirmation.",
					blocks,
				});
				logLeave("updated cancellation option message to confirmation prompt", {
					actionId: action.id,
					channelId: params.channelId,
					botMessageTs: params.replaceMessageTs,
				});
				return;
			}

			const sent = await ctx.slack.postMessage(params.channelId, {
				text: "🔄 Leave cancellation ready for confirmation.",
				blocks,
				threadTs: getThreadAnchor(params.sourceMessageTs, params.sourceThreadTs),
			});

			updatePendingActionBotMessageTs(this.db, action.id, sent.ts);
			logLeave("posted cancellation confirmation message", {
				actionId: action.id,
				channelId: params.channelId,
				botMessageTs: sent.ts,
				threadTs: getThreadAnchor(params.sourceMessageTs, params.sourceThreadTs),
			});
		};

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

			const lowerText = msg.text.toLowerCase();
			const hasKeyword = triggerKeywords.some((keyword) => lowerText.includes(keyword));
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

			let threadContext = "";
			if (msg.threadTs) {
				const replies = await ctx.slack.getThreadReplies(msg.channelId, msg.threadTs);
				threadContext = replies
					.map((reply) => `${reply.userId === msg.userId ? "User" : "Bot"}: ${reply.text}`)
					.join("\n");
				logLeave("loaded thread context", {
					channelId: msg.channelId,
					threadTs: msg.threadTs,
					replyCount: replies.length,
				});
			}

			const currentDate = localDateStringInTimeZone(user.slack_timezone, new Date());
			const systemPrompt = `You are a helpful assistant that parses leave requests and cancellations.
Extract the leave dates, type, category, and times when relevant.
Use these leave types:
- full: a full-day leave
- half_am: a morning half-day leave
- half_pm: an afternoon half-day leave
- specific: a leave with an explicit start and end time
For specific leave, include both start_time and end_time in 24-hour HH:MM format.
Never use type=specific unless both start and end time are known.
If the user indicates a time-specific leave but one of the times is missing,
lower confidence and explain that the exact time range is incomplete.
If the user is cancelling leave, set is_cancellation to true.
If the message is not a leave request or cancellation, set is_leave_request to false.
Resolve relative dates like today, tomorrow, next Monday, and next week
into concrete YYYY-MM-DD dates using the current date and the user's timezone.
If leave type is not specified, default to full.
If category is not specified, default to vacation unless the user clearly indicates sickness or a medical reason.
Prefer an actionable interpretation when there is a reasonable single reading.
Use low confidence only when you still cannot produce a safe actionable interpretation.
The current date is ${currentDate}.
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

			if (parsed.is_cancellation) {
				if (parsed.dates.length === 0) {
					const cancelableRecords = getCancelableLeaveRecordsByUser(this.db, user.id, currentDate, 5);
					const options: InteractiveOption[] = cancelableRecords.map((record) => ({
						text: `Cancel ${formatLeaveDateLabel(record.date)}`,
						value: encodeSelectionPayload({
							kind: "cancel",
							dates: [record.date],
							sourceMessageTs: msg.ts,
							sourceThreadTs: msg.threadTs,
						}),
						actionId: "leave_select_cancel_option",
						style: "danger",
					}));
					options.push({
						text: "✗ Keep everything",
						value: encodeSelectionPayload({ kind: "dismiss", message: "✅ Kept leave as is." }),
						actionId: "leave_dismiss_option",
					});

					const blocks =
						cancelableRecords.length > 0
							? buildCancellationSelectionBlocks(options)
							: buildInteractiveChoiceBlocks(
									[
										"🔄 I couldn't identify a specific leave entry to cancel,",
										"and there are no recent leave records available to select.",
									].join(" "),
									options,
								);

					await ctx.slack.postMessage(msg.channelId, {
						text: "🔄 Select a leave entry to cancel.",
						blocks,
						threadTs: getThreadAnchor(msg.ts, msg.threadTs),
					});
					logLeave("presented cancellation options", {
						channelId: msg.channelId,
						userId: msg.userId,
						ts: msg.ts,
						optionCount: options.length,
					});
					return null;
				}

				await showCancellationConfirmation({
					userDbId: user.id,
					slackUserId: msg.userId,
					channelId: msg.channelId,
					sourceMessageTs: msg.ts,
					sourceThreadTs: msg.threadTs,
					dates: parsed.dates.map((date) => date.date),
				});
				return null;
			}

			if (
				parsed.confidence === "low" ||
				parsed.dates.length === 0 ||
				isSpecificLeaveMissingTime(parsed.dates[0]?.type, parsed.dates[0]?.start_time, parsed.dates[0]?.end_time)
			) {
				if (parsed.confidence === "low") {
					logLeave("parser returned low confidence", {
						channelId: msg.channelId,
						userId: msg.userId,
						ts: msg.ts,
						ambiguityNotes: parsed.ambiguity_notes,
						parsed,
					});
				} else {
					logLeave("leave request had no parsed dates", {
						channelId: msg.channelId,
						userId: msg.userId,
						ts: msg.ts,
						parsed,
					});
				}

				const options = buildCreateSelectionOptions(msg.text, parsed, user.slack_timezone, msg.ts, msg.threadTs);
				await presentLeaveOptions({
					channelId: msg.channelId,
					sourceMessageTs: msg.ts,
					sourceThreadTs: msg.threadTs,
					messageText: msg.text,
					parsed,
					timeZone: user.slack_timezone,
				});
				logLeave("presented leave options instead of asking for clarification", {
					channelId: msg.channelId,
					userId: msg.userId,
					ts: msg.ts,
					optionCount: options.length,
				});
				return null;
			}

			await showLeaveConfirmation({
				userDbId: user.id,
				slackUserId: msg.userId,
				channelId: msg.channelId,
				sourceMessageTs: msg.ts,
				sourceThreadTs: msg.threadTs,
				dates: parsed.dates.map((date) => date.date),
				leaveType: parsed.dates[0].type,
				startTime: parsed.dates[0].start_time,
				endTime: parsed.dates[0].end_time,
				category: parsed.dates[0].category,
				reason: parsed.original_text_summary,
			});
			return null;
		});

		ctx.slack.onAction(/^leave_select_create_option$/, async (event) => {
			const payload = decodeSelectionPayload(event.value);
			if (payload?.kind !== "create") {
				logLeave("received invalid leave create selection payload", {
					channelId: event.channelId,
					userId: event.userId,
					messageTs: event.messageTs,
				});
				return;
			}

			const user = getUserBySlackId(this.db, event.userId);
			if (!user) {
				logLeave("could not resolve user for leave create selection", {
					channelId: event.channelId,
					userId: event.userId,
					messageTs: event.messageTs,
				});
				return;
			}

			logLeave("leave option selected", {
				channelId: event.channelId,
				userId: event.userId,
				messageTs: event.messageTs,
				dates: payload.dates,
				leaveType: payload.leaveType,
				startTime: payload.startTime,
				endTime: payload.endTime,
				category: payload.category,
			});
			await showLeaveConfirmation({
				userDbId: user.id,
				slackUserId: event.userId,
				channelId: event.channelId,
				sourceMessageTs: payload.sourceMessageTs,
				sourceThreadTs: payload.sourceThreadTs,
				dates: payload.dates,
				leaveType: payload.leaveType,
				startTime: payload.startTime,
				endTime: payload.endTime,
				category: payload.category,
				reason: payload.reason,
				replaceMessageTs: event.messageTs,
			});
		});

		ctx.slack.onAction(/^leave_select_cancel_option$/, async (event) => {
			const payload = decodeSelectionPayload(event.value);
			if (payload?.kind !== "cancel") {
				logLeave("received invalid leave cancel selection payload", {
					channelId: event.channelId,
					userId: event.userId,
					messageTs: event.messageTs,
				});
				return;
			}

			const user = getUserBySlackId(this.db, event.userId);
			if (!user) {
				logLeave("could not resolve user for leave cancel selection", {
					channelId: event.channelId,
					userId: event.userId,
					messageTs: event.messageTs,
				});
				return;
			}

			logLeave("leave cancellation option selected", {
				channelId: event.channelId,
				userId: event.userId,
				messageTs: event.messageTs,
				dates: payload.dates,
			});
			await showCancellationConfirmation({
				userDbId: user.id,
				slackUserId: event.userId,
				channelId: event.channelId,
				sourceMessageTs: payload.sourceMessageTs,
				sourceThreadTs: payload.sourceThreadTs,
				dates: payload.dates,
				replaceMessageTs: event.messageTs,
			});
		});

		ctx.slack.onAction(/^leave_dismiss_option$/, async (event) => {
			const payload = decodeSelectionPayload(event.value);
			const message = payload?.kind === "dismiss" ? payload.message : "✅ No changes made.";
			logLeave("leave option flow dismissed", {
				channelId: event.channelId,
				userId: event.userId,
				messageTs: event.messageTs,
				message,
			});
			await ctx.slack.updateMessage(event.channelId, event.messageTs, {
				text: message,
				blocks: [
					{
						type: "section",
						text: { type: "mrkdwn", text: `*${message}*` },
					},
				],
			});
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
			updatePendingActionStatus(this.db, actionId, "confirmed");
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
