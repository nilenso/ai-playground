import type { Static } from "@sinclair/typebox";
import type { Block } from "../../interfaces/slack.js";
import type { LeaveDateSchema } from "./schema.js";

type LeaveDate = Static<typeof LeaveDateSchema>;

function formatLeaveDate(ld: LeaveDate): string {
	const date = new Date(`${ld.date}T12:00:00Z`); // use noon to avoid tz issues
	const dateStr = date.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	const typeStr = ld.type === "full" ? "Full day" : ld.type === "half_am" ? "First half" : "Second half";
	const categoryStr = ld.category.charAt(0).toUpperCase() + ld.category.slice(1);
	return `• ${dateStr} — ${typeStr} (${categoryStr})`;
}

export function buildConfirmationBlocks(dates: LeaveDate[], actionId: string, hasConflict: boolean = false): Block[] {
	const text = hasConflict
		? `⚠️ You already have leave recorded for some of these dates.\n\nI'll record the following *NEW* leave:\n${dates.map(formatLeaveDate).join("\n")}`
		: `📅 I'll record the following leave for you:\n\n${dates.map(formatLeaveDate).join("\n")}\n\nThis will:\n• Create events in the Leave calendar\n• Log appropriate hours in Harvest`;

	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text,
			},
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "✓ Confirm",
						emoji: true,
					},
					value: actionId,
					action_id: "leave_confirm",
					style: "primary",
				},
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "✗ Cancel",
						emoji: true,
					},
					value: actionId,
					action_id: "leave_cancel",
					style: "danger",
				},
			],
		},
	];
}

export function buildCancellationClarificationBlocks(): Block[] {
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: '🔄 Which leave dates would you like to cancel?\n\nPlease reply in this thread with the specific dates, e.g., "cancel my leave on Jan 3" or "cancel Jan 3-5"',
			},
		},
	];
}

export function buildCancellationConfirmationBlocks(dates: LeaveDate[], actionId: string): Block[] {
	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `🔄 I'll cancel your leave for:\n\n${dates.map(formatLeaveDate).join("\n")}\n\nThis will delete the calendar event and Harvest entry.`,
			},
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "✓ Yes, cancel",
						emoji: true,
					},
					value: actionId,
					action_id: "leave_confirm_cancel",
					style: "danger",
				},
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "✗ Keep it",
						emoji: true,
					},
					value: actionId,
					action_id: "leave_abort_cancel",
				},
			],
		},
	];
}
