// A throwaway self-signed TLS certificate, made with Node alone (no openssl
// binary, no files): an EC P-256 key and a minimal X.509 v3 certificate,
// DER-encoded by hand and signed with ecdsa-with-SHA256. For tests that need
// https on a local server; the browser side must ignore certificate errors.
// Not a test file itself (`npm test` runs tests/*.test.mjs only).

import { X509Certificate, generateKeyPairSync, randomBytes, sign } from "node:crypto";

function len(n) {
	if (n < 0x80) return Buffer.from([n]);
	const bytes = [];
	for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);

function oid(dotted) {
	const [a, b, ...rest] = dotted.split(".").map(Number);
	const out = [40 * a + b];
	for (const n of rest) {
		const chunk = [n & 0x7f];
		for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
}

function integer(buf) {
	const b = buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
	return tlv(0x02, b);
}

function utcTime(date) {
	const s = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
	return tlv(0x17, Buffer.from(`${s}Z`, "ascii"));
}

/**
 * `{ key, cert }` PEM strings for `https.createServer`, valid for a day,
 * with `localhost` and `127.0.0.1` as subject alternative names.
 */
export function selfSignedCert() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
	const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("trawl-test")))));
	const now = Date.now();
	const san = seq(tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1])));
	const extensions = tlv(0xa3, seq(seq(oid("2.5.29.17"), tlv(0x04, san))));
	const tbs = seq(
		tlv(0xa0, integer(Buffer.from([2]))),
		integer(Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
		ecdsaSha256,
		name,
		seq(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 86400_000))),
		name,
		publicKey.export({ type: "spki", format: "der" }),
		extensions,
	);
	const signature = sign("sha256", tbs, privateKey);
	const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), signature));
	const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
	// Fail here, not in a TLS handshake, if the encoding is ever wrong.
	if (!new X509Certificate(cert).verify(publicKey)) throw new Error("self-signed certificate does not verify");
	return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert };
}
