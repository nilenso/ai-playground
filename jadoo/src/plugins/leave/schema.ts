import { Type } from "@sinclair/typebox";

export const LeaveDateSchema = Type.Object({
	date: Type.String({ description: "The date of the leave in YYYY-MM-DD format" }),
	type: Type.Union([Type.Literal("full"), Type.Literal("half_am"), Type.Literal("half_pm")], {
		description: "Whether the leave is for a full day, morning half, or afternoon half",
	}),
	category: Type.Union([Type.Literal("vacation"), Type.Literal("sick")], {
		description: "The category of the leave",
	}),
});

export const ParsedLeaveSchema = Type.Object({
	is_leave_request: Type.Boolean({ description: "True if the user is asking for or mentioning taking leave" }),
	is_cancellation: Type.Boolean({ description: "True if the user is explicitly cancelling previously taken leave" }),
	confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
		description: "Confidence in parsing the dates, times, and intent",
	}),
	dates: Type.Array(LeaveDateSchema, { description: "The list of discrete dates extracted from the request" }),
	original_text_summary: Type.String({ description: "A brief summary of what the user literally said" }),
	ambiguity_notes: Type.String({
		description: "Any notes about why the confidence is medium or low, or why clarification might be needed",
	}),
});
