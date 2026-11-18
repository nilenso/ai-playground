import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { checkRoots } from "../check-container-trust.ts";

// Public root certificate from Bun 1.3.13's bundled trust store, not a private key.
const affected = readFileSync(new URL("./fixtures/emsign-ecc-g3.pem", import.meta.url), "utf8");

test("trust check rejects the affected public root even in a mixed bundle", () => {
	const trusted = rootCertificates[0];
	if (!trusted) throw new Error("Missing bundled roots");
	expect(() => checkRoots("test", [trusted, affected])).toThrow("still trusts emSign ECC Root CA - G3");
});

test("trust check rejects empty or malformed bundles", () => {
	expect(() => checkRoots("test", [])).toThrow("no certificates found");
	expect(() => checkRoots("test", ["not a certificate"])).toThrow();
});

test("trust check accepts the refreshed Bun embedded roots", () => {
	expect(checkRoots("Bun", rootCertificates)).toBeGreaterThan(0);
});
