import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Database } from "@db/sqlite";

import type { AppConfig } from "../config.ts";
import { getRpId } from "../config.ts";
import { base64UrlToBytes, bytesToBase64Url } from "../lib/base64url.ts";
import {
	createUser,
	findActiveCredentialByUserId,
	findUserByUsername,
	replaceCredential,
	updateCredentialUsage,
	updateUserPasskeyResetRequired,
} from "../db/repos.ts";
import type { PasskeyCredential, User } from "../types.ts";
import { ChallengeStore } from "./challenges.ts";

type RegistrationResponseLike = Parameters<typeof verifyRegistrationResponse>[0]["response"];
type AuthenticationResponseLike = Parameters<typeof verifyAuthenticationResponse>[0]["response"];
type TransportList = NonNullable<
	NonNullable<Parameters<typeof generateAuthenticationOptions>[0]["allowCredentials"]>[number]["transports"]
>;

export function normalizeUsername(username: string): string {
	return username.trim().toLowerCase();
}

function expectedOrigin(config: AppConfig): string {
	return config.publicBaseUrl;
}

function roleForUsername(config: AppConfig, username: string): "admin" | "user" {
	return normalizeUsername(username) === normalizeUsername(config.adminUsername) ? "admin" : "user";
}

export async function startRegistration(
	db: Database,
	config: AppConfig,
	challengeStore: ChallengeStore,
	input: { username: string; displayName?: string },
) {
	const username = normalizeUsername(input.username);
	const existingUser = findUserByUsername(db, username);
	const activeCredential = existingUser ? findActiveCredentialByUserId(db, existingUser.id) : null;

	if (existingUser && !existingUser.passkey_reset_required && activeCredential) {
		throw new Error("That username already has a registered passkey.");
	}

	const userId = existingUser?.id ?? crypto.randomUUID();
	const userIdBytes = new Uint8Array(new TextEncoder().encode(userId).buffer);
	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: getRpId(config),
		userName: username,
		userID: userIdBytes,
		userDisplayName: input.displayName?.trim() || username,
		attestationType: "none",
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "preferred",
		},
		excludeCredentials: activeCredential ? [{ id: activeCredential.credential_id }] : [],
	});

	challengeStore.create({
		type: "register",
		username,
		challenge: options.challenge,
		userId,
	});

	return options;
}

export async function finishRegistration(
	db: Database,
	config: AppConfig,
	challengeStore: ChallengeStore,
	input: { username: string; displayName?: string; response: Record<string, unknown> },
): Promise<User> {
	const username = normalizeUsername(input.username);
	const challenge = challengeStore.consume("register", username);
	if (!challenge) {
		throw new Error("Registration challenge expired. Please try again.");
	}

	const verification = await verifyRegistrationResponse({
		response: input.response as unknown as RegistrationResponseLike,
		expectedChallenge: challenge.challenge,
		expectedOrigin: expectedOrigin(config),
		expectedRPID: getRpId(config),
		requireUserVerification: false,
	});

	if (!verification.verified || !verification.registrationInfo) {
		throw new Error("Passkey registration could not be verified.");
	}

	let user = findUserByUsername(db, username);
	if (!user) {
		user = createUser(db, {
			id: challenge.userId,
			username,
			displayName: input.displayName?.trim() || username,
			role: roleForUsername(config, username),
			passkeyResetRequired: false,
		});
	} else {
		updateUserPasskeyResetRequired(db, user.id, false);
	}

	const transports = readTransports(input.response);
	const credential = verification.registrationInfo.credential;
	replaceCredential(db, {
		id: crypto.randomUUID(),
		userId: user.id,
		credentialId: credential.id,
		publicKey: bytesToBase64Url(credential.publicKey),
		counter: credential.counter,
		transportsJson: transports.length > 0 ? JSON.stringify(transports) : null,
	});
	updateUserPasskeyResetRequired(db, user.id, false);
	return findUserByUsername(db, username)!;
}

export async function startLogin(
	db: Database,
	config: AppConfig,
	challengeStore: ChallengeStore,
	usernameInput: string,
) {
	const username = normalizeUsername(usernameInput);
	const user = findUserByUsername(db, username);
	if (!user) {
		throw new Error("No user found for that username.");
	}
	if (user.passkey_reset_required) {
		throw new Error("Passkey reset required. Register a new passkey for this username first.");
	}
	const credential = findActiveCredentialByUserId(db, user.id);
	if (!credential) {
		throw new Error("No active passkey found for that username.");
	}

	const options = await generateAuthenticationOptions({
		rpID: getRpId(config),
		allowCredentials: [
			{
				id: credential.credential_id,
				transports: parseTransports(credential),
			},
		],
		userVerification: "preferred",
	});

	challengeStore.create({
		type: "login",
		username,
		challenge: options.challenge,
		userId: user.id,
	});

	return options;
}

export async function finishLogin(
	db: Database,
	config: AppConfig,
	challengeStore: ChallengeStore,
	input: { username: string; response: Record<string, unknown> },
): Promise<User> {
	const username = normalizeUsername(input.username);
	const challenge = challengeStore.consume("login", username);
	if (!challenge) {
		throw new Error("Login challenge expired. Please try again.");
	}

	const user = findUserByUsername(db, username);
	if (!user) {
		throw new Error("No user found for that username.");
	}
	const credential = findActiveCredentialByUserId(db, user.id);
	if (!credential) {
		throw new Error("No active passkey found for that username.");
	}

	const verification = await verifyAuthenticationResponse({
		response: input.response as unknown as AuthenticationResponseLike,
		expectedChallenge: challenge.challenge,
		expectedOrigin: expectedOrigin(config),
		expectedRPID: getRpId(config),
		credential: {
			id: credential.credential_id,
			publicKey: asArrayBufferBytes(base64UrlToBytes(credential.public_key)),
			counter: credential.counter,
			transports: parseTransports(credential),
		},
		requireUserVerification: false,
	});

	if (!verification.verified) {
		throw new Error("Passkey login could not be verified.");
	}

	updateCredentialUsage(db, credential.credential_id, verification.authenticationInfo.newCounter);
	return user;
}

function readTransports(response: Record<string, unknown>): string[] {
	const nested = response.response;
	if (!nested || typeof nested !== "object") {
		return [];
	}
	const transports = (nested as { transports?: unknown }).transports;
	return Array.isArray(transports) ? transports.filter((value): value is string => typeof value === "string") : [];
}

function parseTransports(credential: PasskeyCredential): TransportList {
	if (!credential.transports_json) {
		return [];
	}
	try {
		const parsed = JSON.parse(credential.transports_json);
		return (Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: []) as TransportList;
	} catch {
		return [] as TransportList;
	}
}

function asArrayBufferBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
	return value as Uint8Array<ArrayBuffer>;
}
