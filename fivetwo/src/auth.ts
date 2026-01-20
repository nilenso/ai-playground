import { jwt, sign } from "hono/jwt";
import type { Context, MiddlewareHandler } from "hono";

export interface JWTPayload {
  sub: number; // user ID
  iat: number; // issued at
  exp: number; // expiration
  [key: string]: unknown; // index signature for hono/jwt compatibility
}

export function createJwtMiddleware(secret: string): MiddlewareHandler {
  return jwt({ secret });
}

export function getUserIdFromContext(c: Context): number {
  const payload = c.get("jwtPayload") as JWTPayload;
  return payload.sub;
}

const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;

export async function generateJwt(
  secret: string,
  userId: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: userId,
    iat: now,
    exp: now + ONE_WEEK_SECONDS,
  };
  return await sign(payload, secret);
}
