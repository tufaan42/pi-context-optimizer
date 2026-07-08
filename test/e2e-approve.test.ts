// Status-watch reconciliation: flip status.json approval=approved and assert
// the watcher fires the EXECUTING transition.
//
// Run: node --test --experimental-strip-types test/e2e-approve.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startStatusWatch, readStatus } from "../approval.ts";
import { artifactDirFor, STATUS_FILE } from "../utils.ts";

test("startStatusWatch reconciles approval=approved into the callback", async () => {
	const dir = artifactDirFor("/tmp/ag-watchtest", null);
	await mkdir(dir, { recursive: true });
	const statusPath = join(dir, STATUS_FILE);
	await writeFile(
		statusPath,
		JSON.stringify({ phase: "REVIEW_PENDING", approval: "pending", done: 0, total: 0, updatedAt: new Date().toISOString() }) + "\n",
		"utf8",
	);

	const seen = new Set<string>();
	const watcher = startStatusWatch(dir, (s) => {
		seen.add(s.approval);
	});

	// Flip the marker from outside (this is exactly what the VS Code
	// "Pi: Approve Plan" command does).
	await new Promise((r) => setTimeout(r, 100));
	await writeFile(
		statusPath,
		JSON.stringify({ phase: "REVIEW_PENDING", approval: "approved", done: 0, total: 0, updatedAt: new Date().toISOString() }) + "\n",
		"utf8",
	);

	await new Promise((r) => setTimeout(r, 500));
	watcher.stop();

	const final = await readStatus(statusPath);
	assert.equal(final?.approval, "approved");
	assert.ok(seen.has("approved"), `watcher did not observe approval=approved (saw: ${[...seen].join(",")})`);
});