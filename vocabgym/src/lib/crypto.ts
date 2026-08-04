import { bytesToBase64Url } from "./base64url.ts";

export async function sha256Base64Url(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return bytesToBase64Url(new Uint8Array(digest));
}
