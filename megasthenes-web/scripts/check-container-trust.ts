import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";

export function checkRoots(store: string, certificates: readonly string[]): number {
	if (certificates.length === 0) throw new Error(`${store}: no certificates found`);
	for (const pem of certificates) {
		const certificate = new X509Certificate(pem);
		if (certificate.subject.split("\n").includes("CN=emSign ECC Root CA - G3")) {
			throw new Error(`${store}: still trusts emSign ECC Root CA - G3 (${certificate.fingerprint256})`);
		}
	}
	return certificates.length;
}

if (import.meta.main) {
	const systemBundle = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8");
	const systemRoots = systemBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
	const system = checkRoots("Alpine system roots", systemRoots);
	const bundled = checkRoots("Bun embedded roots", rootCertificates);
	console.log(JSON.stringify({ bun: Bun.version, systemRoots: system, bunEmbeddedRoots: bundled, affectedRoots: [] }));
}
