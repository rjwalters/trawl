import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, parseViewport } from "../src/cli.mjs";

test("collects a bare url as a positional", () => {
	assert.deepEqual(parseArgs(["https://example.com"])._, [
		"https://example.com",
	]);
});

test("expands short aliases", () => {
	const args = parseArgs(["https://example.com", "-f", "html", "-s", "#main"]);
	assert.equal(args["--format"], "html");
	assert.equal(args["--selector"], "#main");
});

test("accepts --flag=value", () => {
	assert.equal(parseArgs(["--format=links", "u"])["--format"], "links");
});

test("treats boolean flags as booleans", () => {
	assert.equal(parseArgs(["-S", "u"])["--show-status"], true);
});

test("treats --ignore-robots as a boolean", () => {
	assert.equal(parseArgs(["--ignore-robots", "u"])["--ignore-robots"], true);
	assert.equal(parseArgs(["u"])["--ignore-robots"], undefined);
});

test("keeps the url positional even after valued flags", () => {
	const args = parseArgs(["--timeout", "5000", "https://example.com"]);
	assert.deepEqual(args._, ["https://example.com"]);
	assert.equal(args["--timeout"], "5000");
});

test("rejects an unknown option", () => {
	assert.throws(() => parseArgs(["--nope", "u"]), /Unknown option: --nope/);
});

test("rejects a valued flag with no value", () => {
	assert.throws(
		() => parseArgs(["https://example.com", "--format"]),
		/--format requires a value/,
	);
});

test("takes a file path for --har", () => {
	const args = parseArgs(["https://example.com", "--har", "out.har"]);
	assert.equal(args["--har"], "out.har");
	assert.deepEqual(args._, ["https://example.com"]);
});

test("treats --har-omit-content as a boolean", () => {
	const args = parseArgs(["https://example.com", "--har-omit-content"]);
	assert.equal(args["--har-omit-content"], true);
	assert.deepEqual(args._, ["https://example.com"]);
});

test("does not mistake a negative-looking value for a flag", () => {
	assert.equal(parseArgs(["-A", "-weird-ua", "u"])["--user-agent"], "-weird-ua");
});

test("takes a path for --screenshot", () => {
	assert.equal(
		parseArgs(["u", "--screenshot", "out.png"])["--screenshot"],
		"out.png",
	);
});

test("treats --full-page as a boolean", () => {
	assert.equal(parseArgs(["u", "--full-page"])["--full-page"], true);
});

test("takes a WxH value for --viewport", () => {
	assert.equal(
		parseArgs(["u", "--viewport", "1280x800"])["--viewport"],
		"1280x800",
	);
});

test("parses a well-formed --viewport into width/height", () => {
	assert.deepEqual(parseViewport("1280x800"), { width: 1280, height: 800 });
});

for (const bad of ["1280", "1280x", "x800", "1280X800", "1280x800px", ""]) {
	test(`rejects malformed --viewport ${JSON.stringify(bad)}`, () => {
		assert.throws(
			() => parseViewport(bad),
			new Error(
				`--viewport expects <width>x<height>, e.g. 1280x800, got "${bad}"`,
			),
		);
	});
}

for (const bad of ["0x600", "1280x0", "0x0"]) {
	test(`rejects a non-positive --viewport dimension ${bad}`, () => {
		assert.throws(
			() => parseViewport(bad),
			new Error(
				`--viewport expects <width>x<height>, e.g. 1280x800, got "${bad}"`,
			),
		);
	});
}

test("treats --no-readability as a boolean flag", () => {
	const args = parseArgs(["u", "-f", "md", "--no-readability"]);
	assert.equal(args["--no-readability"], true);
	assert.deepEqual(args._, ["u"]);
});
