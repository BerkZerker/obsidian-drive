import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mergeThreeWay, isMergeableTextPath } = require("./build/merge.cjs");

const cases = [
	["disjoint edits", "a\nb\nc\nd\ne", "A\nb\nc\nd\ne", "a\nb\nc\nd\nE", "A\nb\nc\nd\nE"],
	["only local changed", "a\nb\nc", "a\nX\nc", "a\nb\nc", "a\nX\nc"],
	["only remote changed", "a\nb\nc", "a\nb\nc", "a\nY\nc", "a\nY\nc"],
	["identical edits deduplicate", "a\nb\nc", "a\nZ\nc", "a\nZ\nc", "a\nZ\nc"],
	["overlapping edits conflict", "a\nb\nc", "a\nX\nc", "a\nY\nc", null],
	["insert vs delete disjoint", "a\nb\nc\nd", "a\nNEW\nb\nc\nd", "a\nb\nc", "a\nNEW\nb\nc"],
	["append vs top edit", "title\n\nbody", "title\n\nbody\nmore", "TITLE\n\nbody", "TITLE\n\nbody\nmore"],
	["both delete same line", "a\nb\nc", "a\nc", "a\nc", "a\nc"],
	["both append differently at end conflicts", "a\nb", "a\nb\nX", "a\nb\nY", null],
	["empty line vs empty segment", "a\n\nb", "a\n\nb\nc", "a\n\nb", "a\n\nb\nc"],
	[
		"multi-hunk merge",
		"l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8",
		"l1\nA\nl3\nl4\nB\nl6\nl7\nl8",
		"l1\nl2\nl3\nC\nl4\nl5\nl6\nl7\nD",
		"l1\nA\nl3\nC\nl4\nB\nl6\nl7\nD",
	],
	["no changes at all", "x\ny", "x\ny", "x\ny", "x\ny"],
	["one side empties file", "a\nb", "", "a\nb", ""],
];

for (const [name, base, local, remote, expected] of cases) {
	test(`merge: ${name}`, () => {
		assert.equal(mergeThreeWay(base, local, remote), expected);
	});
}

test("merge is symmetric for disjoint edits", () => {
	const base = "one\ntwo\nthree\nfour";
	const a = "ONE\ntwo\nthree\nfour";
	const b = "one\ntwo\nthree\nFOUR";
	assert.equal(mergeThreeWay(base, a, b), mergeThreeWay(base, b, a));
});

test("isMergeableTextPath", () => {
	assert.equal(isMergeableTextPath("notes/daily.md"), true);
	assert.equal(isMergeableTextPath("assets/photo.png"), false);
	assert.equal(isMergeableTextPath("no-extension"), false);
	assert.equal(isMergeableTextPath("weird.dir/file"), false);
	assert.equal(isMergeableTextPath("data.canvas"), true);
});
