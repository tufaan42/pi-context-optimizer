// Deterministic unit tests for the pure gate math + todo helpers.
// Run: node --test --experimental-strip-types test/utils.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isSafeReadonlyCommand,
	extractTaskItems,
	markDoneSteps,
	renderTasksMd,
} from "../utils.ts";

test("isSafeReadonlyCommand allows read-only inspection", () => {
	assert.equal(isSafeReadonlyCommand("ls -la"), true);
	assert.equal(isSafeReadonlyCommand("rg foo src/"), true);
	assert.equal(isSafeReadonlyCommand("cat README.md"), true);
	assert.equal(isSafeReadonlyCommand("git status"), true);
	assert.equal(isSafeReadonlyCommand("git log --oneline"), true);
	assert.equal(isSafeReadonlyCommand("node --version"), true);
});

test("isSafeReadonlyCommand blocks mutations", () => {
	assert.equal(isSafeReadonlyCommand("rm -rf /"), false);
	assert.equal(isSafeReadonlyCommand("echo x > file.txt"), false);
	assert.equal(isSafeReadonlyCommand("npm install"), false);
	assert.equal(isSafeReadonlyCommand("git commit -m x"), false);
	assert.equal(isSafeReadonlyCommand("mkdir foo"), false);
	assert.equal(isSafeReadonlyCommand("code file.txt"), false, "code editor opener must be blocked (extension opens files itself)");
	assert.equal(isSafeReadonlyCommand("sudo rm /etc/x"), false);
});

test("extractTaskItems reads numbered steps under a Plan:/Tasks: header", () => {
	const msg = `Here is the plan:\n\nPlan:\n1. Refactor auth service\n2. Add tests for login\n3. Update docs\n\nDone.`;
	const items = extractTaskItems(msg);
	assert.equal(items.length, 3);
	assert.equal(items[0]?.step, 1);
	assert.equal(items[0]?.text, "Refactor auth service");
	assert.equal(items[2]?.step, 3);
});

test("extractTaskItems returns [] when no header present", () => {
	assert.deepEqual(extractTaskItems("just prose, no plan header"), []);
});

test("markDoneSteps flips [DONE:n] steps to done", () => {
	const items = extractTaskItems("Plan:\n1. First task here\n2. Second step now\n3. Third one then\n");
	const n = markDoneSteps("finished [DONE:1] and [DONE:3]", items);
	assert.equal(n, 2);
	assert.equal(items[0]?.status, "done");
	assert.equal(items[1]?.status, "pending");
	assert.equal(items[2]?.status, "done");
});

test("renderTasksMd renders checkbox states deterministically", () => {
	const md = renderTasksMd([
		{ step: 1, text: "Done step here", status: "done" },
		{ step: 2, text: "Active step now", status: "in_progress" },
		{ step: 3, text: "Future step yet", status: "pending" },
	]);
	assert.ok(md.includes("- [x] 1. Done step"));
	assert.ok(md.includes("- [/] 2. Active step"));
	assert.ok(md.includes("- [ ] 3. Future step"));
});