import assert from "node:assert/strict";
import test from "node:test";
import { redactHar } from "../src/render.mjs";

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
