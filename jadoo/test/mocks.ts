/**
 * Mock implementations of all service interfaces for testing.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import type {
	AICompletionRequest,
	AICompletionResponse,
	AIService,
	AIStructuredRequest,
} from "../src/interfaces/ai.js";
import type {
	CalendarEvent,
	CalendarService,
	CreateEventRequest,
	ListEventsRequest,
} from "../src/interfaces/calendar.js";
import type { CreateTimeEntryRequest, HarvestService, HarvestUser } from "../src/interfaces/harvest.js";
import type {
	ActionEvent,
	ActionHandler,
	MessageHandler,
	PostMessageOptions,
	SentMessage,
	SlackMessage,
	SlackService,
	SlackUserInfo,
	UpdateMessageOptions,
} from "../src/interfaces/slack.js";
import { validateStructuredResponse } from "../src/services/ai/structured.js";

// ─── Mock AI ────────────────────────────────────────────

export class MockAIService implements AIService {
	/** All requests received, for assertions */
	readonly requests: AICompletionRequest[] = [];

	/** Queue of responses to return. If empty, returns a default. */
	readonly responses: AICompletionResponse[] = [];

	/** Queue of structured responses. When set, completeStructured returns these directly (skipping LLM prompt + parse). */
	readonly structuredResponses: unknown[] = [];

	/** Default response when queue is empty */
	defaultResponse: AICompletionResponse = {
		content: "mock response",
		stopReason: "stop",
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
	};

	async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
		this.requests.push(request);
		return this.responses.shift() ?? this.defaultResponse;
	}

	async completeStructured<T extends TSchema>(request: AIStructuredRequest, schema: T): Promise<Static<T>> {
		this.requests.push(request);

		// If pre-canned structured responses are queued, return directly
		if (this.structuredResponses.length > 0) {
			return this.structuredResponses.shift() as Static<T>;
		}

		// Otherwise, use the text response queue and run it through validation
		const textResponse = this.responses.shift() ?? this.defaultResponse;
		const result = validateStructuredResponse(schema, textResponse.content);
		if (!result.ok) {
			throw new Error(`MockAIService.completeStructured: ${result.error}`);
		}
		return result.value;
	}
}

// ─── Mock Calendar ──────────────────────────────────────

export class MockCalendarService implements CalendarService {
	readonly events: CalendarEvent[] = [];
	readonly createdEvents: CreateEventRequest[] = [];
	readonly deletedIds: string[] = [];

	private nextId = 1;

	async listEvents(request: ListEventsRequest): Promise<CalendarEvent[]> {
		return this.events.filter((e) => e.start >= request.timeMin && e.end <= request.timeMax);
	}

	async createEvent(request: CreateEventRequest): Promise<CalendarEvent> {
		this.createdEvents.push(request);
		const event: CalendarEvent = {
			id: `mock-${this.nextId++}`,
			summary: request.summary,
			description: request.description,
			start: request.start,
			end: request.end,
			attendees: request.attendees,
			location: request.location,
		};
		this.events.push(event);
		return event;
	}

	async deleteEvent(eventId: string): Promise<void> {
		this.deletedIds.push(eventId);
		const idx = this.events.findIndex((e) => e.id === eventId);
		if (idx >= 0) this.events.splice(idx, 1);
	}
}

// ─── Mock Harvest ───────────────────────────────────────

export class MockHarvestService implements HarvestService {
	readonly createdEntries: CreateTimeEntryRequest[] = [];
	readonly deletedEntryIds: number[] = [];
	readonly users: HarvestUser[] = [];

	private nextEntryId = 1000;

	/** If set, createTimeEntry will throw with this message */
	createError: string | null = null;

	async createTimeEntry(request: CreateTimeEntryRequest): Promise<number> {
		if (this.createError) {
			throw new Error(this.createError);
		}
		this.createdEntries.push(request);
		return this.nextEntryId++;
	}

	async deleteTimeEntry(entryId: number): Promise<void> {
		this.deletedEntryIds.push(entryId);
	}

	async getUsers(): Promise<HarvestUser[]> {
		return this.users;
	}

	async checkConnection(): Promise<boolean> {
		return true;
	}
}

// ─── Mock Slack ─────────────────────────────────────────

interface RegisteredAction {
	pattern: RegExp;
	handler: ActionHandler;
}

/** Recorded postMessage call, including the options. */
export interface SentSlackMessage extends SentMessage {
	options: PostMessageOptions;
}

/** Recorded updateMessage call. */
export interface UpdatedSlackMessage {
	channel: string;
	ts: string;
	options: UpdateMessageOptions;
}

export class MockSlackService implements SlackService {
	readonly messageHandlers: MessageHandler[] = [];
	readonly actionHandlers: RegisteredAction[] = [];

	/** All messages posted via postMessage() */
	readonly postedMessages: SentSlackMessage[] = [];
	/** All messages updated via updateMessage() */
	readonly updatedMessages: UpdatedSlackMessage[] = [];

	/** Canned user info — keyed by user ID */
	readonly users: Map<string, SlackUserInfo> = new Map();
	/** Canned thread replies — keyed by `${channel}:${ts}` */
	readonly threads: Map<string, SlackMessage[]> = new Map();

	private running = false;
	private nextTs = 1000;

	// ── Lifecycle ──────────────────────────────

	async start(): Promise<void> {
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
	}

	get isRunning(): boolean {
		return this.running;
	}

	// ── Incoming events ───────────────────────

	onMessage(handler: MessageHandler): void {
		this.messageHandlers.push(handler);
	}

	onAction(pattern: RegExp, handler: ActionHandler): void {
		this.actionHandlers.push({ pattern, handler });
	}

	// ── Outgoing messages ─────────────────────

	async postMessage(channel: string, options: PostMessageOptions): Promise<SentMessage> {
		const ts = `mock-ts-${this.nextTs++}`;
		const sent: SentSlackMessage = { ts, channelId: channel, options };
		this.postedMessages.push(sent);
		return { ts, channelId: channel };
	}

	async updateMessage(channel: string, ts: string, options: UpdateMessageOptions): Promise<void> {
		this.updatedMessages.push({ channel, ts, options });
	}

	// ── Read APIs ─────────────────────────────

	async getThreadReplies(channel: string, ts: string): Promise<SlackMessage[]> {
		return this.threads.get(`${channel}:${ts}`) ?? [];
	}

	async getUserInfo(userId: string): Promise<SlackUserInfo> {
		return (
			this.users.get(userId) ?? {
				userId,
				displayName: `User ${userId}`,
				isBot: false,
			}
		);
	}

	/** Canned channel members — keyed by channel ID */
	readonly channelMembers: Map<string, string[]> = new Map();

	async getChannelMembers(channel: string): Promise<string[]> {
		return this.channelMembers.get(channel) ?? [];
	}

	// ── Test helpers ──────────────────────────

	/**
	 * Simulate an incoming message. Runs all message handlers and collects replies.
	 */
	async simulateMessage(message: SlackMessage): Promise<(string | null | undefined)[]> {
		const replies: (string | null | undefined)[] = [];
		for (const handler of this.messageHandlers) {
			replies.push(await handler(message));
		}
		return replies;
	}

	/**
	 * Simulate a button click / action. Dispatches to matching action handlers.
	 */
	async simulateAction(event: ActionEvent): Promise<void> {
		for (const { pattern, handler } of this.actionHandlers) {
			if (pattern.test(event.actionId)) {
				await handler(event);
			}
		}
	}

	/**
	 * Seed a user for getUserInfo() lookups.
	 */
	addUser(info: SlackUserInfo): void {
		this.users.set(info.userId, info);
	}

	/**
	 * Seed thread replies for getThreadReplies() lookups.
	 */
	addThreadReplies(channel: string, ts: string, messages: SlackMessage[]): void {
		this.threads.set(`${channel}:${ts}`, messages);
	}
}
