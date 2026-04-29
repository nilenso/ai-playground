/**
 * Centralized logging setup using LogTape.
 *
 * Logger hierarchy:
 *   megasthenes-web              — root logger
 *   megasthenes-web.http         — HTTP request/response logging (via @logtape/hono)
 *   megasthenes-web.ws           — WebSocket events (connect, ask, cancel, resume)
 *   megasthenes-web.session      — Session lifecycle (connect, restore, disconnect, cleanup)
 *   megasthenes-web.compaction   — Context compaction events
 *   megasthenes-web.auth         — Authentication (OAuth, JWT)
 *   megasthenes-web.sandbox      — Sandbox interactions
 *   megasthenes-web.startup      — Server startup
 */

import { configure, getConsoleSink, getLogger } from "@logtape/logtape";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warning" | "error";

export async function setupLogging(): Promise<void> {
	await configure({
		sinks: {
			console: getConsoleSink(),
		},
		loggers: [
			{
				category: ["logtape", "meta"],
				lowestLevel: "warning",
				sinks: ["console"],
			},
			{
				category: ["megasthenes-web"],
				lowestLevel: LOG_LEVEL,
				sinks: ["console"],
			},
			// Quiet down HTTP request logs in production unless LOG_LEVEL=debug
			{
				category: ["megasthenes-web", "http"],
				lowestLevel: LOG_LEVEL === "debug" ? "debug" : "info",
				sinks: ["console"],
			},
		],
	});
}

// Pre-built loggers for each subsystem
export const logger = getLogger(["megasthenes-web"]);
export const httpLogger = getLogger(["megasthenes-web", "http"]);
export const wsLogger = getLogger(["megasthenes-web", "ws"]);
export const sessionLogger = getLogger(["megasthenes-web", "session"]);
export const compactionLogger = getLogger(["megasthenes-web", "compaction"]);
export const authLogger = getLogger(["megasthenes-web", "auth"]);
export const sandboxLogger = getLogger(["megasthenes-web", "sandbox"]);
export const startupLogger = getLogger(["megasthenes-web", "startup"]);
