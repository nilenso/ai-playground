import {
  ClientSession,
  deriveScram,
  formatClientFinal,
  formatClientFirst,
  formatServerFinal,
  formatServerFirst,
  parseClientFinal,
  parseClientFirst,
  parseServerFinal,
  parseServerFirst,
  ScramError,
  ServerSession,
  verifyClientProof,
} from "./scram.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
function equalBytes(a: Uint8Array, b: Uint8Array): void {
  assert(a.length === b.length);
  for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `byte ${i}`);
}
async function rejects(
  fn: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof ScramError);
    assert(error.code === code);
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("SCRAM-SHA-256 matches RFC 7677 calculations", async () => {
  const salt = bytes("W22ZaJ0SNY7soEsUEjb6gQ==");
  const authMessage = "n=user,r=rOprNGfwEbeRWgbNEkqO," +
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  const result = await deriveScram(
    new TextEncoder().encode("pencil"),
    salt,
    4096,
    authMessage,
  );
  equalBytes(
    result.clientProof,
    bytes("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="),
  );
  equalBytes(
    result.serverSignature,
    bytes("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="),
  );
  assert(
    await verifyClientProof(result.storedKey, authMessage, result.clientProof),
  );
  const bad = result.clientProof.slice();
  bad[0] ^= 1;
  assert(!(await verifyClientProof(result.storedKey, authMessage, bad)));
  await rejects(
    () => deriveScram(new Uint8Array(), salt, 4095, authMessage),
    "IterationCountTooLow",
  );
});

Deno.test("strict SCRAM wire profile only accepts canonical messages", () => {
  const nonce = "0123456789abcdefghijk-lmnopqrstuvwxyzABCDEF";
  const id = "d9428888-122b-4fee-9bb0-d7c1651c1f8b";
  const first = parseClientFirst(`n,,n=${id},r=${nonce}`);
  assert(first.instanceId === id);
  assert(first.nonce === nonce);
  assert(formatClientFirst(id, nonce) === `n,,n=${id},r=${nonce}`);
  for (
    const alternate of [
      `n,,r=${nonce},n=${id}`,
      `n,,n=${id.toUpperCase()},r=${nonce}`,
      `n,a=x,n=${id},r=${nonce}`,
      `n,,n=${id},r=${nonce}+`,
    ]
  ) {
    try {
      parseClientFirst(alternate);
      throw new Error("accepted malformed first");
    } catch (error) {
      assert(error instanceof ScramError);
    }
  }
  const challenge = {
    instanceId: id,
    clientNonce: nonce,
    serverNonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi-jklmnopq",
    salt: new Uint8Array(16),
    iterations: 4096,
  };
  assert(
    formatServerFirst(challenge) ===
      `r=${nonce}${challenge.serverNonce},s=AAAAAAAAAAAAAAAAAAAAAA==,i=4096`,
  );
  const parsedChallenge = parseServerFirst(
    formatServerFirst(challenge),
    id,
    nonce,
  );
  assert(parsedChallenge.serverNonce === challenge.serverNonce);
  equalBytes(parsedChallenge.salt, challenge.salt);
  const proof = new Uint8Array(32);
  const final = formatClientFinal(challenge, proof);
  equalBytes(parseClientFinal(final, challenge), proof);
  const serverFinal = formatServerFinal(proof);
  equalBytes(parseServerFinal(serverFinal), proof);
  try {
    parseServerFinal(serverFinal.replace(/=$/, "A"));
    throw new Error("accepted noncanonical base64");
  } catch (error) {
    assert(error instanceof ScramError);
  }
});

Deno.test("SCRAM sessions gate application data and mutually verify", async () => {
  const secret = new Uint8Array(32).fill(0x5a);
  const salt = new Uint8Array(16).fill(0x19);
  const id = "d9428888-122b-4fee-9bb0-d7c1651c1f8b";
  let server = new ServerSession(secret, salt, 4096);
  let challenge = await server.begin(
    id,
    "clientNonce0123456789abcdef",
    "serverNonce9876543210fedcba",
  );
  let client = await ClientSession.respond(secret, challenge);
  assert(!server.canAcceptApplication && !client.canSendApplication);
  const badProof = client.proof.slice();
  badProof[0] ^= 1;
  await rejects(() => server.finish(badProof), "InvalidProof");
  assert(!server.canAcceptApplication);

  server = new ServerSession(secret, salt, 4096);
  challenge = await server.begin(
    id,
    "clientNonce0123456789abcdef",
    "freshServerNonce9876543210",
  );
  client = await ClientSession.respond(secret, challenge);
  const signature = await server.finish(client.proof);
  assert(!server.canAcceptApplication);
  assert(!client.canSendApplication);
  await client.verifyServer(signature);
  assert(client.canSendApplication);
  server.confirm();
  assert(server.canAcceptApplication);
  await rejects(() => server.finish(client.proof), "InvalidState");
  await rejects(() => client.verifyServer(signature), "InvalidState");
});
