import type { Database } from "bun:sqlite";
import { getUserById, updatePendingActionStatus } from "../../db/index.js";
import type { DbPendingAction } from "../../db/types.js";
import type { BackgroundWorker } from "../../worker.js";
import {
	incrementLeaveRecordRetry,
	updateLeaveRecordStatus,
	upsertLeaveRecord,
} from "./leave-records.js";
import type { CancelLeavePayload, CreateLeavePayload } from "./types.js";
import { logger } from "../../logger.js";

// Hardcoded logic previously in worker.ts
export function registerLeaveHandlers(worker: BackgroundWorker, db: Database, config: { vacationTaskId: number, sickTaskId: number, projectId: number }, calendar: any, harvest: any, slack: any) {
    worker.registerHandler("create_leave", async (action: DbPendingAction, w: BackgroundWorker) => {
		const payload = JSON.parse(action.payload) as CreateLeavePayload;
		const user = getUserById(db, action.user_id);
		if (!user) {
			logger.error("user not found for action", null, { userId: action.user_id, actionId: action.id });
			updatePendingActionStatus(db, action.id, "failed");
			return;
		}

		let allSucceeded = true;

		for (const date of payload.dates) {
			// Upsert a leave record in 'confirmed' state
			const record = upsertLeaveRecord(db, {
				userId: user.id,
				date,
				leaveType: payload.leaveType,
				leaveCategory: payload.category,
				slackMessageTs: action.slack_message_ts,
				slackChannelId: action.slack_channel_id,
				status: "confirmed",
			});

			try {
				// Sync to Calendar
				const start = new Date(`${date}T00:00:00`);
				const end = new Date(`${date}T23:59:59`);
				const calEvent = await calendar.createEvent({
					summary: `${user.slack_display_name} — ${payload.category} (${payload.leaveType})`,
					description: payload.reason,
					start,
					end,
				});

				// Sync to Harvest (only if user has a Harvest mapping)
				let harvestEntryId: number | null = null;
				if (user.harvest_user_id) {
                    const taskId = payload.category === "sick" ? config.sickTaskId : config.vacationTaskId;
                    const hours = payload.leaveType === "full" ? 8 : 4;
					harvestEntryId = await harvest.createTimeEntry({
						harvestUserId: user.harvest_user_id,
						date,
                        projectId: config.projectId,
                        taskId,
                        hours,
						notes: payload.reason,
					});
				}

				// Mark leave record as completed
				updateLeaveRecordStatus(db, record.id, {
					status: "completed",
					calendarEventId: calEvent.id,
					harvestEntryId,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const retryCount = incrementLeaveRecordRetry(db, record.id, msg);
                const maxRetries = (worker as any).maxRetries ?? 3;

				if (retryCount >= maxRetries) {
					updateLeaveRecordStatus(db, record.id, {
						status: "failed",
						errorMessage: `Max retries (${maxRetries}) exceeded. Last error: ${msg}`,
					});
				} else {
					// Revert to confirmed so it gets picked up again
					updateLeaveRecordStatus(db, record.id, { status: "confirmed" });
				}

				allSucceeded = false;
			}
		}

		if (allSucceeded) {
			updatePendingActionStatus(db, action.id, "completed");
			await notifyCompleted(action, payload, slack);
		} else {
			// Check if any records still need processing
			const hasRetriable = payload.dates.some((date) => {
				const records = db
					.query<{ status: string }, [number, string]>(
						"SELECT status FROM leave_records WHERE user_id = ? AND date = ?",
					)
					.all(action.user_id, date);
				return records.some((r) => r.status === "confirmed");
			});

			if (hasRetriable) {
				// Put the action back to confirmed for next tick
				updatePendingActionStatus(db, action.id, "confirmed");
			} else {
				// All dates either completed or failed
				updatePendingActionStatus(db, action.id, "failed");
				await notifyFailed(action, slack);
			}
		}
	});

    worker.registerHandler("cancel_leave", async (action: DbPendingAction, w: BackgroundWorker) => {
		const payload = JSON.parse(action.payload) as CancelLeavePayload;
		const user = getUserById(db, action.user_id);
		if (!user) {
			logger.error("user not found for action", null, { userId: action.user_id, actionId: action.id });
			updatePendingActionStatus(db, action.id, "failed");
			return;
		}

		// Find existing leave records for these dates
		const records = db
			.query<
				{ id: number; date: string; calendar_event_id: string | null; harvest_entry_id: number | null },
				(number | string)[]
			>(
				`SELECT id, date, calendar_event_id, harvest_entry_id FROM leave_records
			 WHERE user_id = ? AND date IN (${payload.dates.map(() => "?").join(", ")})
			 AND status IN ('confirmed', 'completed')`,
			)
			.all(user.id, ...payload.dates);

		for (const record of records) {
			try {
				if (record.calendar_event_id) {
					await calendar.deleteEvent(record.calendar_event_id);
				}
				if (record.harvest_entry_id) {
					await harvest.deleteTimeEntry(record.harvest_entry_id);
				}
				updateLeaveRecordStatus(db, record.id, { status: "cancelled" });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error("failed to cancel leave record", err, { recordId: record.id });
				updateLeaveRecordStatus(db, record.id, {
					status: "failed",
					errorMessage: msg,
				});
			}
		}

		updatePendingActionStatus(db, action.id, "completed");
		await notifyCancelled(action, payload, slack);
	});
}


async function notifyCompleted(action: DbPendingAction, payload: CreateLeavePayload, slack: any): Promise<void> {
    const channel = action.slack_channel_id;
    const ts = action.slack_bot_message_ts;
    if (!channel || !ts) return;

    const dateList = payload.dates.join(", ");
    try {
        await slack.updateMessage(channel, ts, {
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
        logger.error("failed to update Slack message for action", err, { actionId: action.id });
    }
}

async function notifyFailed(action: DbPendingAction, slack: any): Promise<void> {
    const channel = action.slack_channel_id;
    const ts = action.slack_bot_message_ts;
    if (!channel || !ts) return;

    try {
        await slack.updateMessage(channel, ts, {
            text: "❌ Leave sync failed after retries. Please contact an admin.",
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "❌ *Leave sync failed* after retries. Please contact an admin.",
                    },
                },
            ],
        });
    } catch (err) {
        logger.error("failed to update Slack message for action", err, { actionId: action.id });
    }
}

async function notifyCancelled(action: DbPendingAction, payload: CancelLeavePayload, slack: any): Promise<void> {
    const channel = action.slack_channel_id;
    const ts = action.slack_bot_message_ts;
    if (!channel || !ts) return;

    const dateList = payload.dates.join(", ");
    try {
        await slack.updateMessage(channel, ts, {
            text: `🗑️ Leave cancelled: ${dateList}`,
            blocks: [
                {
                    type: "section",
                    text: { type: "mrkdwn", text: `🗑️ *Leave cancelled*\n📅 ${dateList}` },
                },
            ],
        });
    } catch (err) {
        logger.error("failed to update Slack message for action", err, { actionId: action.id });
    }
}
