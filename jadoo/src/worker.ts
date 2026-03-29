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
	updatePendingActionStatus,
} from "./db/index.js";
import type { DbPendingAction } from "./db/types.js";
import type { CalendarService } from "./interfaces/calendar.js";
import type { HarvestService } from "./interfaces/harvest.js";
import type { SlackService } from "./interfaces/slack.js";

// ─── Config ─────────────────────────────────────────────

export interface WorkerConfig {
	/** How often to poll for confirmed actions (ms). Default: 5000 */
	processIntervalMs?: number;
	/** How often to sweep for expired actions (ms). Default: 30000 */
	expiryIntervalMs?: number;
	/** Max retries per leave record before marking as failed. Default: 3 */
	maxRetries?: number;
}

export type ActionHandlerFn = (action: DbPendingAction, worker: BackgroundWorker) => Promise<void>;

const DEFAULT_PROCESS_INTERVAL = 5_000;
const DEFAULT_EXPIRY_INTERVAL = 30_000;
const DEFAULT_MAX_RETRIES = 3;

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
    private handlers: Map<string, ActionHandlerFn> = new Map();

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
		for (const action of actions) {
			try {
				await this.processAction(action);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[worker] failed to process action ${action.id}: ${msg}`);
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

    registerHandler(actionType: string, handler: ActionHandlerFn): void {
        this.handlers.set(actionType, handler);
    }

	// ── Action processing ─────────────────────

	private async processAction(action: DbPendingAction): Promise<void> {
        const handler = this.handlers.get(action.action_type);
        if (handler) {
            await handler(action, this);
        } else {
            console.warn(`[worker] unknown action type: ${action.action_type}`);
            updatePendingActionStatus(this.db, action.id, "failed");
        }
	}

	// ── Slack notifications ───────────────────

	async notifyExpired(action: DbPendingAction): Promise<void> {
		const channel = action.slack_channel_id;
		const ts = action.slack_bot_message_ts;
		if (!channel || !ts) return;

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
