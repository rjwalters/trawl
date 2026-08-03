import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/cli.mjs";

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
