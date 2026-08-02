import { isUuidV4 } from "./uuid.ts";

export type ScramErrorCode =
  | "IterationCountTooLow"
  | "InvalidIterations"
  | "InvalidInstanceId"
  | "InvalidNonce"
  | "InvalidSecret"
  | "InvalidSalt"
  | "InvalidProof"
  | "InvalidServerSignature"
  | "InvalidState"
  | "MalformedScram";
export class ScramError extends Error {
  constructor(public readonly code: ScramErrorCode) {
    super(code);
    this.name = "ScramError";
  }
}
function fail(code: ScramErrorCode): never {
  throw new ScramError(code);
}
const textEncoder = new TextEncoder();

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
async function hmac(
  keyBytes: Uint8Array,
  data: Uint8Array | string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = typeof data === "string" ? textEncoder.encode(data) : data;
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, ownedBuffer(input)),
  );
}
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBuffer(data)),
  );
}
function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length);
  for (let i = 0; i < result.length; i++) result[i] = left[i] ^ right[i];
  return result;
}
function equalConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeCanonicalBase64(value: string, length: number): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    fail("MalformedScram");
  }
  if (decoded.length !== length || base64(decoded) !== value) {
    fail("MalformedScram");
  }
  return decoded;
}
function validNonce(value: string): boolean {
  if (value.length < 24 || value.length > 96) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e || code === 0x2c) return false;
  }
  return true;
}
function validateChallenge(challenge: Challenge): void {
  if (!isUuidV4(challenge.instanceId)) fail("InvalidInstanceId");
  if (
    !validNonce(challenge.clientNonce) || !validNonce(challenge.serverNonce)
  ) fail("InvalidNonce");
  if (
    !Number.isInteger(challenge.iterations) || challenge.iterations < 4096 ||
    challenge.iterations > 1_000_000
  ) fail("InvalidIterations");
  if (challenge.salt.length !== 16) fail("InvalidSalt");
}

export interface ScramExchange {
  storedKey: Uint8Array;
  clientProof: Uint8Array;
  serverSignature: Uint8Array;
}
export async function deriveScram(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  authMessage: string,
): Promise<ScramExchange> {
  if (!Number.isInteger(iterations) || iterations < 4096) {
    fail("IterationCountTooLow");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const saltedPassword = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: ownedBuffer(salt), iterations },
      material,
      256,
    ),
  );
  const clientKey = await hmac(saltedPassword, "Client Key");
  const storedKey = await sha256(clientKey);
  const clientSignature = await hmac(storedKey, authMessage);
  const serverKey = await hmac(saltedPassword, "Server Key");
  return {
    storedKey,
    clientProof: xor(clientKey, clientSignature),
    serverSignature: await hmac(serverKey, authMessage),
  };
}
export async function verifyClientProof(
  storedKey: Uint8Array,
  authMessage: string,
  proof: Uint8Array,
): Promise<boolean> {
  if (storedKey.length !== 32 || proof.length !== 32) return false;
  const signature = await hmac(storedKey, authMessage);
  return equalConstantTime(storedKey, await sha256(xor(proof, signature)));
}

export interface Challenge {
  instanceId: string;
  clientNonce: string;
  serverNonce: string;
  salt: Uint8Array;
  iterations: number;
}
function authMessage(challenge: Challenge): string {
  const first = `n=${challenge.instanceId},r=${challenge.clientNonce}`;
  const server = formatServerFirst(challenge);
  const final = `c=biws,r=${challenge.clientNonce}${challenge.serverNonce}`;
  return `${first},${server},${final}`;
}

export interface ClientFirst {
  instanceId: string;
  nonce: string;
}
export function formatClientFirst(instanceId: string, nonce: string): string {
  if (!isUuidV4(instanceId)) fail("InvalidInstanceId");
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) fail("InvalidNonce");
  return `n,,n=${instanceId},r=${nonce}`;
}
export function parseClientFirst(message: string): ClientFirst {
  const match = /^n,,n=([^,]{36}),r=([A-Za-z0-9_-]{43})$/.exec(message);
  if (!match || !isUuidV4(match[1])) fail("MalformedScram");
  return { instanceId: match[1], nonce: match[2] };
}
export function formatServerFirst(challenge: Challenge): string {
  validateChallenge(challenge);
  return `r=${challenge.clientNonce}${challenge.serverNonce},s=${
    base64(challenge.salt)
  },i=${challenge.iterations}`;
}
export function parseServerFirst(
  message: string,
  instanceId: string,
  clientNonce: string,
): Challenge {
  if (!isUuidV4(instanceId) || !/^[A-Za-z0-9_-]{43}$/.test(clientNonce)) {
    fail("MalformedScram");
  }
  const prefix = `r=${clientNonce}`;
  if (!message.startsWith(prefix)) fail("MalformedScram");
  const match = /^([^,]{24,96}),s=([A-Za-z0-9+/]{22}==),i=([1-9][0-9]*)$/.exec(
    message.slice(prefix.length),
  );
  if (!match) fail("MalformedScram");
  const iterations = Number(match[3]);
  if (
    !Number.isSafeInteger(iterations) || iterations < 4096 ||
    iterations > 1_000_000
  ) {
    fail("MalformedScram");
  }
  const challenge = {
    instanceId,
    clientNonce,
    serverNonce: match[1],
    salt: decodeCanonicalBase64(match[2], 16),
    iterations,
  };
  validateChallenge(challenge);
  return challenge;
}
export function formatClientFinal(
  challenge: Challenge,
  proof: Uint8Array,
): string {
  validateChallenge(challenge);
  if (proof.length !== 32) fail("InvalidProof");
  return `c=biws,r=${challenge.clientNonce}${challenge.serverNonce},p=${
    base64(proof)
  }`;
}
export function parseClientFinal(
  message: string,
  challenge: Challenge,
): Uint8Array {
  validateChallenge(challenge);
  const prefix = `c=biws,r=${challenge.clientNonce}${challenge.serverNonce},p=`;
  if (!message.startsWith(prefix) || message.length !== prefix.length + 44) {
    fail("MalformedScram");
  }
  return decodeCanonicalBase64(message.slice(prefix.length), 32);
}
export function formatServerFinal(signature: Uint8Array): string {
  if (signature.length !== 32) fail("InvalidServerSignature");
  return `v=${base64(signature)}`;
}
export function parseServerFinal(message: string): Uint8Array {
  if (message.length !== 46 || !message.startsWith("v=")) {
    fail("MalformedScram");
  }
  return decodeCanonicalBase64(message.slice(2), 32);
}

export class ServerSession {
  #phase:
    | "waiting_first"
    | "waiting_proof"
    | "waiting_confirmation"
    | "authenticated"
    | "failed" = "waiting_first";
  #expectedProof?: Uint8Array;
  #serverSignature?: Uint8Array;
  constructor(
    private readonly secret: Uint8Array,
    private readonly salt: Uint8Array,
    private readonly iterations: number,
  ) {
    if (secret.length !== 32) fail("InvalidSecret");
    if (salt.length !== 16) fail("InvalidSalt");
    if (
      !Number.isInteger(iterations) || iterations < 4096 ||
      iterations > 1_000_000
    ) fail("InvalidIterations");
    this.secret = secret.slice();
    this.salt = salt.slice();
  }
  async begin(
    instanceId: string,
    clientNonce: string,
    serverNonce: string,
  ): Promise<Challenge> {
    if (this.#phase !== "waiting_first") fail("InvalidState");
    const challenge = {
      instanceId,
      clientNonce,
      serverNonce,
      salt: this.salt.slice(),
      iterations: this.iterations,
    };
    validateChallenge(challenge);
    const exchange = await deriveScram(
      this.secret,
      challenge.salt,
      challenge.iterations,
      authMessage(challenge),
    );
    this.#expectedProof = exchange.clientProof;
    this.#serverSignature = exchange.serverSignature;
    this.#phase = "waiting_proof";
    return challenge;
  }
  finish(proof: Uint8Array): Uint8Array {
    if (
      this.#phase !== "waiting_proof" || !this.#expectedProof ||
      !this.#serverSignature
    ) fail("InvalidState");
    if (!equalConstantTime(proof, this.#expectedProof)) {
      this.#phase = "failed";
      fail("InvalidProof");
    }
    this.#phase = "waiting_confirmation";
    return this.#serverSignature.slice();
  }
  confirm(): void {
    if (this.#phase !== "waiting_confirmation") fail("InvalidState");
    this.#phase = "authenticated";
  }
  get canAcceptApplication(): boolean {
    return this.#phase === "authenticated";
  }
}

export class ClientSession {
  #verified = false;
  private constructor(
    public readonly proof: Uint8Array,
    private readonly expectedServerSignature: Uint8Array,
  ) {}
  static async respond(
    secret: Uint8Array,
    challenge: Challenge,
  ): Promise<ClientSession> {
    if (secret.length !== 32) fail("InvalidSecret");
    validateChallenge(challenge);
    const exchange = await deriveScram(
      secret,
      challenge.salt,
      challenge.iterations,
      authMessage(challenge),
    );
    return new ClientSession(exchange.clientProof, exchange.serverSignature);
  }
  verifyServer(signature: Uint8Array): void {
    if (this.#verified) fail("InvalidState");
    if (!equalConstantTime(signature, this.expectedServerSignature)) {
      fail("InvalidServerSignature");
    }
    this.#verified = true;
  }
  get canSendApplication(): boolean {
    return this.#verified;
  }
}
