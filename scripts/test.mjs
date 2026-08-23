// Bundles the pure (Obsidian-free) modules and runs the node:test suites.
import { build } from "esbuild";
import { spawnSync } from "child_process";
import { mkdirSync, readdirSync } from "fs";

mkdirSync("tests/build", { recursive: true });

for (const name of ["merge", "planner", "crypto"]) {
	await build({
		entryPoints: [`src/${name}.ts`],
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "es2018",
		outfile: `tests/build/${name}.cjs`,
		logLevel: "silent",
	});
}

// The sync engine pulls in vaultio/driveClient, which import "obsidian";
// alias that to a stub so the whole pipeline is testable under Node.
await build({
	entryPoints: ["src/sync.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2018",
	outfile: "tests/build/sync.cjs",
	alias: { obsidian: "./tests/stubs/obsidian.mjs" },
	logLevel: "silent",
});

const testFiles = readdirSync("tests")
	.filter((f) => f.endsWith(".test.mjs"))
	.map((f) => `tests/${f}`);
const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
