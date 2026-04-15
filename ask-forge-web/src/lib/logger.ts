/**
 * Centralized logging setup using LogTape.
 *
 * Logger hierarchy:
 *   ask-forge-web              — root logger
 *   ask-forge-web.http         — HTTP request/response logging (via @logtape/hono)
 *   ask-forge-web.ws           — WebSocket events (connect, ask, cancel, resume)
 *   ask-forge-web.session      — Session lifecycle (connect, restore, disconnect, cleanup)
 *   ask-forge-web.auth         — Authentication (OAuth, JWT)
 *   ask-forge-web.sandbox      — Sandbox interactions
 *   ask-forge-web.startup      — Server startup
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
				category: ["ask-forge-web"],
				lowestLevel: LOG_LEVEL,
				sinks: ["console"],
			},
			// Quiet down HTTP request logs in production unless LOG_LEVEL=debug
			{
				category: ["ask-forge-web", "http"],
				lowestLevel: LOG_LEVEL === "debug" ? "debug" : "info",
				sinks: ["console"],
			},
		],
	});
}

// Pre-built loggers for each subsystem
export const logger = getLogger(["ask-forge-web"]);
export const httpLogger = getLogger(["ask-forge-web", "http"]);
export const wsLogger = getLogger(["ask-forge-web", "ws"]);
export const sessionLogger = getLogger(["ask-forge-web", "session"]);
export const authLogger = getLogger(["ask-forge-web", "auth"]);
export const sandboxLogger = getLogger(["ask-forge-web", "sandbox"]);
export const startupLogger = getLogger(["ask-forge-web", "startup"]);
