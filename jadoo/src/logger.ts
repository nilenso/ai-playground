/**
 * Simple structured JSON logger.
 * Replaces console.log / console.error directly.
 */

export const logger = {
	info(msg: string, meta?: Record<string, unknown>) {
		console.log(JSON.stringify({ level: "info", msg, ...meta, timestamp: new Date().toISOString() }));
	},
	error(msg: string, err?: Error | unknown, meta?: Record<string, unknown>) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error(JSON.stringify({ level: "error", msg, error: errMsg, ...meta, timestamp: new Date().toISOString() }));
	},
	warn(msg: string, meta?: Record<string, unknown>) {
		console.warn(JSON.stringify({ level: "warn", msg, ...meta, timestamp: new Date().toISOString() }));
	},
};
