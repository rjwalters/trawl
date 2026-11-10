import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { redactHar, redactHarFile } from "../src/render.mjs";

const SENTINEL = "s3cr3t-sentinel";

test("redactHar blanks credential headers and cookie values, keeps names", () => {
	const har = {
		log: {
			entries: [
				{
					request: {
						headers: [
							{ name: "cookie", value: `sid=${SENTINEL}` },
							{ name: "AUTHORIZATION", value: `Bearer ${SENTINEL}` },
							{ name: "Proxy-Authorization", value: SENTINEL },
							{ name: "Accept", value: "text/html" },
						],
						cookies: [{ name: "sid", value: SENTINEL }],
					},
					response: {
						headers: [
							{ name: "Set-Cookie", value: `a=${SENTINEL}` },
							{ name: "set-cookie", value: `b=${SENTINEL}` },
							{ name: "Content-Type", value: "text/html" },
						],
						cookies: [{ name: "a", value: SENTINEL }, { name: "b", value: SENTINEL }],
					},
				},
			],
		},
	};
	const out = JSON.stringify(redactHar(har));
	assert.equal(out.includes(SENTINEL), false);
	for (const name of ["sid", "Accept", "text/html", "Set-Cookie", "Proxy-Authorization"]) {
		assert.ok(out.includes(name), name);
	}
});

test("redactHar tolerates a HAR with no entries or cookies", () => {
	assert.deepEqual(redactHar({ log: { entries: [] } }), { log: { entries: [] } });
	assert.deepEqual(redactHar({}), {});
	assert.doesNotThrow(() => redactHar({ log: { entries: [{ request: {}, response: {} }] } }));
});

function tmpFile(name) {
	return path.join(mkdtempSync(path.join(tmpdir(), "trawl-redact-")), name);
}

test("redactHarFile rewrites a valid HAR in place", () => {
	const file = tmpFile("ok.har");
	writeFileSync(
		file,
		JSON.stringify({
			log: { entries: [{ request: { headers: [{ name: "Cookie", value: SENTINEL }] } }] },
		}),
	);
	redactHarFile(file);
	assert.equal(readFileSync(file, "utf8").includes(SENTINEL), false);
});

test("redactHarFile fails closed: unparseable input is deleted and throws", () => {
	const file = tmpFile("bad.har");
	writeFileSync(file, `PK\u0003\u0004 not json ${SENTINEL}`);
	assert.throws(() => redactHarFile(file), /could not redact HAR/);
	assert.equal(existsSync(file), false, "no HAR may be left behind");
});

test("redactHarFile fails closed: a missing file throws and leaves nothing", () => {
	const file = tmpFile("missing.har");
	assert.throws(() => redactHarFile(file), /could not redact HAR/);
	assert.equal(existsSync(file), false);
});
