/**
 * Background worker — processes confirmed leave actions and sweeps expired ones.
 *
 * Two independent loops on configurable intervals:
 *
 * 1. **Action processor**: Claims confirmed pending_actions → syncs to
 *    Calendar + Harvest → updates leave_records → updates Slack message.
 *
 * 2. **Expiry sweeper**: Marks stale pending_actions as expired and
 *    disables their Slack confirmation buttons.
 *
 * The worker is independent of the Bot / plugin system. They share a database
 * and service interfaces but have separate lifecycles.
 */

import type { Database } from "bun:sqlite";
import {
	claimConfirmedActions,
	expirePendingActions,
	getUserById,
	incrementLeaveRecordRetry,
	updateLeaveRecordStatus,
	updatePendingActionStatus,
	upsertLeaveRecord,
} from "./db/index.js";
import type { DbPendingAction } from "./db/types.js";
import type { CalendarService } from "./interfaces/calendar.js";
import type { HarvestService, LeaveCategory, LeaveType } from "./interfaces/harvest.js";
import type { SlackService } from "./interfaces/slack.js";

// ─── Payload types ──────────────────────────────────────

/** The JSON payload stored in pending_actions for create_leave. */
export interface CreateLeavePayload {
	dates: string[]; // YYYY-MM-DD
	leaveType: string; // 'full' | 'half_am' | 'half_pm'
	category: string; // 'vacation' | 'sick'
	reason?: string;
}

/** The JSON payload stored in pending_actions for cancel_leave. */
export interface CancelLeavePayload {
	dates: string[]; // YYYY-MM-DD
}

interface LeaveProcessingFailure {
	date: string;
	stage: "calendar" | "harvest" | "cancel" | "validation";
	message: string;
}

// ─── Config ─────────────────────────────────────────────

export interface WorkerConfig {
	/** How often to poll for confirmed actions (ms). Default: 5000 */
	processIntervalMs?: number;
	/** How often to sweep for expired actions (ms). Default: 30000 */
	expiryIntervalMs?: number;
	/** Max retries per leave record before marking as failed. Default: 3 */
	maxRetries?: number;
}

const DEFAULT_PROCESS_INTERVAL = 5_000;
const DEFAULT_EXPIRY_INTERVAL = 30_000;
const DEFAULT_MAX_RETRIES = 3;

function logWorker(message: string, details?: Record<string, unknown>): void {
	console.log(`[worker] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

function logWorkerError(message: string, details?: Record<string, unknown>): void {
	console.error(`[worker] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

// ─── Worker ─────────────────────────────────────────────

export interface WorkerDeps {
	db: Database;
	calendar: CalendarService;
	harvest: HarvestService;
	slack: SlackService;
}

export class BackgroundWorker {
	private readonly db: Database;
	private readonly calendar: CalendarService;
	private readonly harvest: HarvestService;
	private readonly slack: SlackService;
	private readonly processIntervalMs: number;
	private readonly expiryIntervalMs: number;
	private readonly maxRetries: number;

	private processTimer: ReturnType<typeof setInterval> | null = null;
	private expiryTimer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(deps: WorkerDeps, config?: WorkerConfig) {
		this.db = deps.db;
		this.calendar = deps.calendar;
		this.harvest = deps.harvest;
		this.slack = deps.slack;
		this.processIntervalMs = config?.processIntervalMs ?? DEFAULT_PROCESS_INTERVAL;
		this.expiryIntervalMs = config?.expiryIntervalMs ?? DEFAULT_EXPIRY_INTERVAL;
		this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
	}

	start(): void {
		if (this.running) return;
		this.running = true;

		// Run immediately on start, then on interval
		this.processTimer = setInterval(() => this.processTick(), this.processIntervalMs);
		this.expiryTimer = setInterval(() => this.expiryTick(), this.expiryIntervalMs);

		// Fire once right away
		this.processTick();
		this.expiryTick();

		console.log(`[worker] started (process: ${this.processIntervalMs}ms, expiry: ${this.expiryIntervalMs}ms)`);
	}

	stop(): void {
		if (!this.running) return;

		if (this.processTimer) clearInterval(this.processTimer);
		if (this.expiryTimer) clearInterval(this.expiryTimer);
		this.processTimer = null;
		this.expiryTimer = null;
		this.running = false;

		console.log("[worker] stopped");
	}

	get isRunning(): boolean {
		return this.running;
	}

	// ── Process tick ──────────────────────────

	/**
	 * Single tick of the action processor.
	 * Public so tests can drive it directly without timers.
	 */
	async processTick(): Promise<void> {
		const actions = claimConfirmedActions(this.db);
		if (actions.length > 0) {
			logWorker("claimed confirmed actions", {
				count: actions.length,
				actionIds: actions.map((action) => action.id),
				actionTypes: actions.map((action) => action.action_type),
			});
		}

		for (const action of actions) {
			try {
				await this.processAction(action);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logWorkerError("failed to process action", {
					actionId: action.id,
					actionType: action.action_type,
					userId: action.user_id,
					message: msg,
				});
				updatePendingActionStatus(this.db, action.id, "failed");
			}
		}
	}

	/**
	 * Single tick of the expiry sweeper.
	 * Public so tests can drive it directly without timers.
	 */
	async expiryTick(): Promise<void> {
		const now = new Date().toISOString();
		const expired = expirePendingActions(this.db, now);

		for (const action of expired) {
			await this.notifyExpired(action);
		}

		if (expired.length > 0) {
			console.log(`[worker] expired ${expired.length} action(s)`);
		}
	}

	// ── Action processing ─────────────────────

	private async processAction(action: DbPendingAction): Promise<void> {
		logWorker("processing action", {
			actionId: action.id,
			actionType: action.action_type,
			status: action.status,
			userId: action.user_id,
			channelId: action.slack_channel_id,
			messageTs: action.slack_message_ts,
			threadTs: action.slack_thread_ts,
			botMessageTs: action.slack_bot_message_ts,
			payload: action.payload,
		});

		switch (action.action_type) {
			case "create_leave":
				await this.processCreateLeave(action);
				break;
			case "cancel_leave":
				await this.processCancelLeave(action);
				break;
			default:
				console.warn(`[worker] unknown action type: ${action.action_type}`);
				updatePendingActionStatus(this.db, action.id, "failed");
		}
	}

	private async processCreateLeave(action: DbPendingAction): Promise<void> {
		const payload = JSON.parse(action.payload) as CreateLeavePayload;
		logWorker("processing create_leave action", {
			actionId: action.id,
			userId: action.user_id,
			payload,
		});

		const user = getUserById(this.db, action.user_id);
		if (!user) {
			logWorkerError("user not found for create_leave action", {
				actionId: action.id,
				userId: action.user_id,
			});
			updatePendingActionStatus(this.db, action.id, "failed");
			await this.notifyFailed(action, [
				{
					date: payload.dates.join(", "),
					stage: "validation",
					message: `User ${action.user_id} no longer exists in Jadoo's database.`,
				},
			]);
			return;
		}

		logWorker("resolved user for create_leave action", {
			actionId: action.id,
			userDbId: user.id,
			slackUserId: user.slack_user_id,
			displayName: user.slack_display_name,
			harvestUserId: user.harvest_user_id,
		});

		let allSucceeded = true;
		const failures: LeaveProcessingFailure[] = [];

		for (const date of payload.dates) {
			logWorker("processing leave date", {
				actionId: action.id,
				userDbId: user.id,
				date,
				leaveType: payload.leaveType,
				category: payload.category,
			});

			// Upsert a leave record in 'confirmed' state
			const record = upsertLeaveRecord(this.db, {
				userId: user.id,
				date,
				leaveType: payload.leaveType,
				leaveCategory: payload.category,
				slackMessageTs: action.slack_message_ts,
				slackChannelId: action.slack_channel_id,
				status: "confirmed",
			});

			logWorker("upserted leave record", {
				actionId: action.id,
				recordId: record.id,
				date,
				status: record.status,
			});

			let stage: LeaveProcessingFailure["stage"] = "calendar";
			try {
				// Sync to Calendar
				const isFullDayLeave = payload.leaveType === "full";
				const start = new Date(`${date}T00:00:00`);
				const end = isFullDayLeave ? new Date(`${date}T00:00:00`) : new Date(`${date}T23:59:59`);
				if (isFullDayLeave) {
					end.setDate(end.getDate() + 1);
				}
				logWorker("creating calendar event", {
					actionId: action.id,
					recordId: record.id,
					date,
					start: start.toISOString(),
					end: end.toISOString(),
					allDay: isFullDayLeave,
				});
				const calEvent = await this.calendar.createEvent({
					summary: `${user.slack_display_name} — ${payload.category} (${payload.leaveType})`,
					description: payload.reason,
					start,
					end,
					allDay: isFullDayLeave,
				});
				logWorker("calendar event created", {
					actionId: action.id,
					recordId: record.id,
					date,
					calendarEventId: calEvent.id,
				});

				// Sync to Harvest (only if user has a Harvest mapping)
				let harvestEntryId: number | null = null;
				if (user.harvest_user_id) {
					stage = "harvest";
					logWorker("creating harvest time entry", {
						actionId: action.id,
						recordId: record.id,
						date,
						harvestUserId: user.harvest_user_id,
						leaveType: payload.leaveType,
						category: payload.category,
					});
					harvestEntryId = await this.harvest.createTimeEntry({
						harvestUserId: user.harvest_user_id,
						date,
						leaveType: payload.leaveType as LeaveType,
						category: payload.category as LeaveCategory,
						notes: payload.reason,
					});
					logWorker("harvest time entry created", {
						actionId: action.id,
						recordId: record.id,
						date,
						harvestEntryId,
					});
				} else {
					logWorker("skipping harvest sync because user has no harvest mapping", {
						actionId: action.id,
						recordId: record.id,
						date,
						userDbId: user.id,
					});
				}

				// Mark leave record as completed
				updateLeaveRecordStatus(this.db, record.id, {
					status: "completed",
					calendarEventId: calEvent.id,
					harvestEntryId,
				});
				logWorker("leave record marked completed", {
					actionId: action.id,
					recordId: record.id,
					date,
					calendarEventId: calEvent.id,
					harvestEntryId,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const retryCount = incrementLeaveRecordRetry(this.db, record.id, msg);
				logWorkerError("failed to process leave date", {
					actionId: action.id,
					recordId: record.id,
					date,
					stage,
					message: msg,
					retryCount,
					maxRetries: this.maxRetries,
				});

				failures.push({ date, stage, message: msg });

				if (retryCount >= this.maxRetries) {
					updateLeaveRecordStatus(this.db, record.id, {
						status: "failed",
						errorMessage: `Max retries (${this.maxRetries}) exceeded. Last error: ${msg}`,
					});
					logWorkerError("leave record marked failed after max retries", {
						actionId: action.id,
						recordId: record.id,
						date,
						retryCount,
						maxRetries: this.maxRetries,
					});
				} else {
					// Revert to confirmed so it gets picked up again
					updateLeaveRecordStatus(this.db, record.id, { status: "confirmed" });
					logWorker("leave record returned to confirmed for retry", {
						actionId: action.id,
						recordId: record.id,
						date,
						retryCount,
						maxRetries: this.maxRetries,
					});
				}

				allSucceeded = false;
			}
		}

		if (allSucceeded) {
			logWorker("all leave dates processed successfully", { actionId: action.id, dates: payload.dates });
			updatePendingActionStatus(this.db, action.id, "completed");
			await this.notifyCompleted(action, payload);
		} else {
			// Check if any records still need processing
			const hasRetriable = payload.dates.some((date) => {
				const records = this.db
					.query<{ status: string }, [number, string]>(
						"SELECT status FROM leave_records WHERE user_id = ? AND date = ?",
					)
					.all(action.user_id, date);
				return records.some((r) => r.status === "confirmed");
			});

			if (hasRetriable) {
				// Put the action back to confirmed for next tick
				logWorker("leave action has retriable dates; moving back to confirmed", {
					actionId: action.id,
					failures,
				});
				updatePendingActionStatus(this.db, action.id, "confirmed");
			} else {
				// All dates either completed or failed
				logWorkerError("leave action failed with no retriable dates remaining", {
					actionId: action.id,
					failures,
				});
				updatePendingActionStatus(this.db, action.id, "failed");
				await this.notifyFailed(action, failures, payload);
			}
		}
	}

	private async processCancelLeave(action: DbPendingAction): Promise<void> {
		const payload = JSON.parse(action.payload) as CancelLeavePayload;
		logWorker("processing cancel_leave action", {
			actionId: action.id,
			userId: action.user_id,
			payload,
		});

		const user = getUserById(this.db, action.user_id);
		if (!user) {
			logWorkerError("user not found for cancel_leave action", {
				actionId: action.id,
				userId: action.user_id,
			});
			updatePendingActionStatus(this.db, action.id, "failed");
			await this.notifyFailed(action, [
				{
					date: payload.dates.join(", "),
					stage: "validation",
					message: `User ${action.user_id} no longer exists in Jadoo's database.`,
				},
			]);
			return;
		}

		logWorker("resolved user for cancel_leave action", {
			actionId: action.id,
			userDbId: user.id,
			slackUserId: user.slack_user_id,
			displayName: user.slack_display_name,
			harvestUserId: user.harvest_user_id,
		});

		// Find existing leave records for these dates
		const records = this.db
			.query<
				{ id: number; date: string; calendar_event_id: string | null; harvest_entry_id: number | null },
				(number | string)[]
			>(
				`SELECT id, date, calendar_event_id, harvest_entry_id FROM leave_records
			 WHERE user_id = ? AND date IN (${payload.dates.map(() => "?").join(", ")})
			 AND status IN ('confirmed', 'completed')`,
			)
			.all(user.id, ...payload.dates);

		logWorker("loaded leave records for cancellation", {
			actionId: action.id,
			requestedDates: payload.dates,
			recordCount: records.length,
			records,
		});

		if (records.length === 0) {
			updatePendingActionStatus(this.db, action.id, "failed");
			await this.notifyFailed(
				action,
				payload.dates.map((date) => ({
					date,
					stage: "validation",
					message: "No matching leave record was found to cancel.",
				})),
			);
			return;
		}

		const failures: LeaveProcessingFailure[] = [];

		for (const record of records) {
			try {
				logWorker("cancelling leave record", {
					actionId: action.id,
					recordId: record.id,
					date: record.date,
					calendarEventId: record.calendar_event_id,
					harvestEntryId: record.harvest_entry_id,
				});
				if (record.calendar_event_id) {
					await this.calendar.deleteEvent(record.calendar_event_id);
					logWorker("deleted calendar event for leave record", {
						actionId: action.id,
						recordId: record.id,
						date: record.date,
						calendarEventId: record.calendar_event_id,
					});
				}
				if (record.harvest_entry_id) {
					await this.harvest.deleteTimeEntry(record.harvest_entry_id);
					logWorker("deleted harvest time entry for leave record", {
						actionId: action.id,
						recordId: record.id,
						date: record.date,
						harvestEntryId: record.harvest_entry_id,
					});
				}
				updateLeaveRecordStatus(this.db, record.id, { status: "cancelled" });
				logWorker("leave record marked cancelled", {
					actionId: action.id,
					recordId: record.id,
					date: record.date,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logWorkerError("failed to cancel leave record", {
					actionId: action.id,
					recordId: record.id,
					date: record.date,
					message: msg,
				});
				failures.push({ date: record.date, stage: "cancel", message: msg });
				updateLeaveRecordStatus(this.db, record.id, {
					status: "failed",
					errorMessage: msg,
				});
			}
		}

		if (failures.length > 0) {
			logWorkerError("cancel_leave action failed", { actionId: action.id, failures });
			updatePendingActionStatus(this.db, action.id, "failed");
			await this.notifyFailed(action, failures);
			return;
		}

		logWorker("cancel_leave action completed", { actionId: action.id, dates: payload.dates });
		updatePendingActionStatus(this.db, action.id, "completed");
		await this.notifyCancelled(action, payload);
	}

	// ── Slack notifications ───────────────────

	private async notifyCompleted(action: DbPendingAction, payload: CreateLeavePayload): Promise<void> {
		const channel = action.slack_channel_id;
		const ts = action.slack_bot_message_ts;
		if (!channel || !ts) {
			logWorker("skipping completion notification because Slack target is missing", {
				actionId: action.id,
				channelId: channel,
				botMessageTs: ts,
			});
			return;
		}

		const dateList = payload.dates.join(", ");
		logWorker("sending completion notification", {
			actionId: action.id,
			channelId: channel,
			botMessageTs: ts,
			dateList,
		});
		try {
			await this.slack.updateMessage(channel, ts, {
				text: `✅ Leave synced: ${dateList} (${payload.category}, ${payload.leaveType})`,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `✅ *Leave synced*\n📅 ${dateList}\n📋 ${payload.category} (${payload.leaveType})`,
						},
					},
				],
			});
		} catch (err) {
			console.error(`[worker] failed to update Slack message for action ${action.id}: ${err}`);
		}
	}

	private async notifyFailed(
		action: DbPendingAction,
		failures: LeaveProcessingFailure[],
		payload?: CreateLeavePayload,
	): Promise<void> {
		const channel = action.slack_channel_id;
		const ts = action.slack_bot_message_ts;
		if (!channel || !ts) {
			logWorker("skipping failure notification because Slack target is missing", {
				actionId: action.id,
				channelId: channel,
				botMessageTs: ts,
				failures,
			});
			return;
		}

		const totalDates = payload?.dates.length;
		const uniqueFailures = failures.slice(0, 5).map((failure) => {
			const stageLabel =
				failure.stage === "calendar"
					? "Calendar"
					: failure.stage === "harvest"
						? "Harvest"
						: failure.stage === "cancel"
							? "Cancellation"
							: "Validation";
			return `• ${failure.date}: ${stageLabel} — ${failure.message}`;
		});
		const summary =
			totalDates && totalDates > failures.length
				? `Some dates may have succeeded, but ${failures.length} date(s) failed.`
				: "The request could not be completed.";
		const message = [
			"❌ Leave processing failed.",
			summary,
			"Please try again or contact an admin.",
			...uniqueFailures,
		].join("\n");

		logWorker("sending failure notification", {
			actionId: action.id,
			channelId: channel,
			botMessageTs: ts,
			summary,
			failureCount: failures.length,
		});
		try {
			await this.slack.updateMessage(channel, ts, {
				text: message,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `❌ *Leave processing failed*\n${summary}\nPlease try again or contact an admin.${uniqueFailures.length ? `\n\n${uniqueFailures.join("\n")}` : ""}`,
						},
					},
				],
			});
		} catch (err) {
			console.error(`[worker] failed to update Slack message for action ${action.id}: ${err}`);
		}
	}

	private async notifyCancelled(action: DbPendingAction, payload: CancelLeavePayload): Promise<void> {
		const channel = action.slack_channel_id;
		const ts = action.slack_bot_message_ts;
		if (!channel || !ts) {
			logWorker("skipping cancellation notification because Slack target is missing", {
				actionId: action.id,
				channelId: channel,
				botMessageTs: ts,
			});
			return;
		}

		const dateList = payload.dates.join(", ");
		logWorker("sending cancellation notification", {
			actionId: action.id,
			channelId: channel,
			botMessageTs: ts,
			dateList,
		});
		try {
			await this.slack.updateMessage(channel, ts, {
				text: `🗑️ Leave cancelled: ${dateList}`,
				blocks: [
					{
						type: "section",
						text: { type: "mrkdwn", text: `🗑️ *Leave cancelled*\n📅 ${dateList}` },
					},
				],
			});
		} catch (err) {
			console.error(`[worker] failed to update Slack message for action ${action.id}: ${err}`);
		}
	}

	private async notifyExpired(action: DbPendingAction): Promise<void> {
		const channel = action.slack_channel_id;
		const ts = action.slack_bot_message_ts;
		if (!channel || !ts) {
			logWorker("skipping expiry notification because Slack target is missing", {
				actionId: action.id,
				channelId: channel,
				botMessageTs: ts,
			});
			return;
		}

		logWorker("sending expiry notification", {
			actionId: action.id,
			channelId: channel,
			botMessageTs: ts,
		});
		try {
			await this.slack.updateMessage(channel, ts, {
				text: "⏰ This leave request has expired. Please submit a new one.",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "⏰ *Expired* — this leave request was not confirmed in time. Please submit a new one.",
						},
					},
				],
			});
		} catch (err) {
			console.error(`[worker] failed to update Slack message for expired action ${action.id}: ${err}`);
		}
	}
}
