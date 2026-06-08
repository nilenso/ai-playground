import type { Static } from "@sinclair/typebox";
import type { Block } from "../../interfaces/slack.js";
import type { LeaveDateSchema } from "./schema.js";

type LeaveDate = Static<typeof LeaveDateSchema>;

export interface InteractiveOption {
	text: string;
	value: string;
	actionId: string;
	style?: "primary" | "danger";
}

function formatCalendarDate(dateText: string): string {
	const date = new Date(`${dateText}T12:00:00Z`);
	return date.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function chunk<T>(items: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}

export function buildInteractiveChoiceBlocks(text: string, options: InteractiveOption[]): Block[] {
	const blocks: Block[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text,
			},
		},
	];

	for (const optionGroup of chunk(options, 5)) {
		blocks.push({
			type: "actions",
			elements: optionGroup.map((option) => ({
				type: "button",
				text: {
					type: "plain_text",
					text: option.text,
					emoji: true,
				},
				value: option.value,
				action_id: option.actionId,
				...(option.style ? { style: option.style } : {}),
			})),
		});
	}

	return blocks;
}

function formatLeaveDate(ld: LeaveDate): string {
	const typeStr =
		ld.type === "full"
			? "Full day"
			: ld.type === "half_am"
				? "First half"
				: ld.type === "half_pm"
					? "Second half"
					: `Time specific (${ld.start_time ?? "?"}-${ld.end_time ?? "?"})`;
	const categoryStr = ld.category.charAt(0).toUpperCase() + ld.category.slice(1);
	return `• ${formatCalendarDate(ld.date)} — ${typeStr} (${categoryStr})`;
}

export function formatLeaveDateLabel(dateText: string): string {
	return formatCalendarDate(dateText);
}

export function formatLeaveDateRangeLabel(dates: string[]): string {
	if (dates.length === 0) return "No dates";
	if (dates.length === 1) return formatLeaveDateLabel(dates[0]);
	return `${formatLeaveDateLabel(dates[0])} → ${formatLeaveDateLabel(dates[dates.length - 1])}`;
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

export function buildLeaveOptionsBlocks(options: InteractiveOption[]): Block[] {
	return buildInteractiveChoiceBlocks(
		"🧭 I couldn't turn that into a final leave action automatically. Choose one of the options below.",
		options,
	);
}

export function buildCancellationSelectionBlocks(options: InteractiveOption[]): Block[] {
	return buildInteractiveChoiceBlocks("🔄 Select a leave entry to cancel.", options);
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
