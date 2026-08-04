import type { MiddlewareHandler } from "hono";

type Bucket = {
	count: number;
	resetAt: number;
};

export function createRateLimit(options: { limit: number; windowMs: number; message: string }): MiddlewareHandler {
	const buckets = new Map<string, Bucket>();

	return async (c, next) => {
		const key = `${c.req.path}:${clientKey(c.req.header("x-forwarded-for") ?? "local")}`;
		const now = Date.now();
		const bucket = buckets.get(key);
		if (!bucket || bucket.resetAt <= now) {
			buckets.set(key, { count: 1, resetAt: now + options.windowMs });
			return await next();
		}
		if (bucket.count >= options.limit) {
			return c.json({ error: options.message }, 429);
		}
		bucket.count += 1;
		await next();
	};
}

function clientKey(forwardedFor: string): string {
	return forwardedFor.split(",")[0]?.trim() || "local";
}
