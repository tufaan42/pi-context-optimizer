import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import contextOptimizerExtension from "../index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_FILE, STATUS_FILE } from "../utils.ts";
import { readStatus } from "../approval.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = join(process.cwd(), `.tmp-escalate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(dir, { recursive: true });
	try {
		await fn(dir);
	} finally {
		await new Promise((r) => setTimeout(r, 60));
		try {
			await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		} catch {
			/* ignore cleanup race */
		}
	}
}

test("Fast Track escalates to REVIEW_PENDING when touching protected files", async () => {
	await withTempDir(async (dir) => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const sentMessages: any[] = [];
		let currentTools = ["read", "bash", "edit", "write"];

		const mockPi = {
			registerFlag() {},
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			getActiveTools: () => currentTools,
			setActiveTools: (tools: string[]) => {
				currentTools = tools;
			},
			appendEntry() {},
			sendMessage(msg: any) {
				sentMessages.push(msg);
			},
			getFlag(name: string) {
				if (name === "ag-fast") return true;
				if (name === "ag-review") return "auto";
				return false;
			},
		} as unknown as ExtensionAPI;

		contextOptimizerExtension(mockPi);

		const mockCtx = {
			cwd: dir,
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => join(dir, "session.jsonl"),
			},
			ui: {
				notify() {},
				setStatus() {},
				theme: { fg: (_c: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		// 1. Start session in Fast Track
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart({}, mockCtx);

		const toolCall = handlers.get("tool_call");
		assert.ok(toolCall);

		// 2. Safe edit 1
		const res1 = await toolCall({ toolName: "edit", input: { path: "src/button.ts" } });
		assert.equal(res1, undefined, "safe edit 1 should not be blocked");

		// 3. Edit protected file -> package.json
		const res2 = await toolCall({ toolName: "edit", input: { path: "package.json" } });
		assert.ok(res2?.block, "protected file edit must be blocked");
		assert.ok(res2?.reason?.includes("Modifying protected path"), "should state protected path violation");

		// 4. Verify message escalated
		const escalationMsg = sentMessages.find((m) => m.customType === "ag-escalated");
		assert.ok(escalationMsg, "should emit ag-escalated message");

		await handlers.get("session_shutdown")?.({}, mockCtx);
	});
});

test("Fast Track escalates to REVIEW_PENDING when blast radius exceeds limit", async () => {
	await withTempDir(async (dir) => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const sentMessages: any[] = [];
		let currentTools = ["read", "bash", "edit", "write"];

		const mockPi = {
			registerFlag() {},
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			getActiveTools: () => currentTools,
			setActiveTools: (tools: string[]) => {
				currentTools = tools;
			},
			appendEntry() {},
			sendMessage(msg: any) {
				sentMessages.push(msg);
			},
			getFlag(name: string) {
				if (name === "ag-fast") return true;
				return false;
			},
		} as unknown as ExtensionAPI;

		contextOptimizerExtension(mockPi);

		const mockCtx = {
			cwd: dir,
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => join(dir, "session.jsonl"),
			},
			ui: {
				notify() {},
				setStatus() {},
				theme: { fg: (_c: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		// Start session in Fast Track
		await handlers.get("session_start")!({}, mockCtx);
		const toolCall = handlers.get("tool_call")!;

		// File 1
		const res1 = await toolCall({ toolName: "edit", input: { path: "src/file1.ts" } });
		assert.equal(res1, undefined);

		// File 2
		const res2 = await toolCall({ toolName: "edit", input: { path: "src/file2.ts" } });
		assert.equal(res2, undefined);

		// File 3 (exceeds FAST_TRACK_MAX_FILES = 2)
		const res3 = await toolCall({ toolName: "edit", input: { path: "src/file3.ts" } });
		assert.ok(res3?.block, "3rd file must be blocked");
		assert.ok(res3?.reason?.includes("File modification threshold"), "should mention threshold exceeded");

		const escalationMsg = sentMessages.find((m) => m.customType === "ag-escalated");
		assert.ok(escalationMsg, "should emit ag-escalated message");

		await handlers.get("session_shutdown")?.({}, mockCtx);
	});
});

test("Fast Track escalates on destructive bash commands", async () => {
	await withTempDir(async (dir) => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const sentMessages: any[] = [];
		let currentTools = ["read", "bash", "edit", "write"];

		const mockPi = {
			registerFlag() {},
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			getActiveTools: () => currentTools,
			setActiveTools: (tools: string[]) => {
				currentTools = tools;
			},
			appendEntry() {},
			sendMessage(msg: any) {
				sentMessages.push(msg);
			},
			getFlag(name: string) {
				if (name === "ag-fast") return true;
				return false;
			},
		} as unknown as ExtensionAPI;

		contextOptimizerExtension(mockPi);

		const mockCtx = {
			cwd: dir,
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => join(dir, "session.jsonl"),
			},
			ui: {
				notify() {},
				setStatus() {},
				theme: { fg: (_c: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		// Start session in Fast Track
		await handlers.get("session_start")!({}, mockCtx);
		const toolCall = handlers.get("tool_call")!;

		// Safe bash command
		const res1 = await toolCall({ toolName: "bash", input: { command: "git status" } });
		assert.equal(res1, undefined, "safe bash should not be blocked in Fast Track");

		// Destructive bash command
		const res2 = await toolCall({ toolName: "bash", input: { command: "rm -rf dist" } });
		assert.ok(res2?.block, "destructive bash must be blocked");
		assert.ok(res2?.reason?.includes("Destructive bash command"), "should block and escalate");

		const escalationMsg = sentMessages.find((m) => m.customType === "ag-escalated");
		assert.ok(escalationMsg, "should emit ag-escalated message");

		await handlers.get("session_shutdown")?.({}, mockCtx);
	});
});

test("Standard Track auto-approves plan when reviewMode is auto", async () => {
	await withTempDir(async (dir) => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const registeredTools = new Map<string, any>();
		const sentMessages: any[] = [];
		let currentTools = ["read", "bash", "edit", "write"];

		const mockPi = {
			registerFlag() {},
			registerCommand() {},
			registerShortcut() {},
			registerTool(tool: any) {
				registeredTools.set(tool.name, tool);
			},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			getActiveTools: () => currentTools,
			setActiveTools: (tools: string[]) => {
				currentTools = tools;
			},
			appendEntry() {},
			sendMessage(msg: any) {
				sentMessages.push(msg);
			},
			getFlag(name: string) {
				if (name === "ag-plan") return true;
				if (name === "ag-review") return "auto";
				return false;
			},
		} as unknown as ExtensionAPI;

		contextOptimizerExtension(mockPi);

		const mockCtx = {
			cwd: dir,
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => join(dir, "session.jsonl"),
			},
			ui: {
				notify() {},
				setStatus() {},
				theme: { fg: (_c: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		// Start session in Plan mode
		await handlers.get("session_start")!({}, mockCtx);

		// Call write_plan with standard risk
		const writePlan = registeredTools.get("write_plan");
		assert.ok(writePlan);

		await writePlan.execute(
			"call-1",
			{
				content: "# Plan\n### Step 1 — build feature\nDo task\n",
				risk_assessment: "low",
			},
			undefined,
			undefined,
			mockCtx,
		);

		// Should auto-approve and emit ag-approved without human /approve command
		const approvedMsg = sentMessages.find((m) => m.customType === "ag-approved");
		assert.ok(approvedMsg, "should auto-approve in Standard Track");

		await handlers.get("session_shutdown")?.({}, mockCtx);
	});
});

test("High-risk plan enforces blocking REVIEW_PENDING even in reviewMode auto", async () => {
	await withTempDir(async (dir) => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const registeredTools = new Map<string, any>();
		const sentMessages: any[] = [];
		let currentTools = ["read", "bash", "edit", "write"];

		const mockPi = {
			registerFlag() {},
			registerCommand() {},
			registerShortcut() {},
			registerTool(tool: any) {
				registeredTools.set(tool.name, tool);
			},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			getActiveTools: () => currentTools,
			setActiveTools: (tools: string[]) => {
				currentTools = tools;
			},
			appendEntry() {},
			sendMessage(msg: any) {
				sentMessages.push(msg);
			},
			getFlag(name: string) {
				if (name === "ag-plan") return true;
				if (name === "ag-review") return "auto";
				return false;
			},
		} as unknown as ExtensionAPI;

		contextOptimizerExtension(mockPi);

		const mockCtx = {
			cwd: dir,
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => join(dir, "session.jsonl"),
			},
			ui: {
				notify() {},
				setStatus() {},
				theme: { fg: (_c: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		// Start session in Plan mode
		await handlers.get("session_start")!({}, mockCtx);

		const writePlan = registeredTools.get("write_plan");
		assert.ok(writePlan);

		await writePlan.execute(
			"call-1",
			{
				content: "# Plan\n### Step 1 — database migration\nAlter table\n",
				risk_assessment: "high",
			},
			undefined,
			undefined,
			mockCtx,
		);

		// Must NOT auto-approve when risk is high
		const approvedMsg = sentMessages.find((m) => m.customType === "ag-approved");
		assert.equal(approvedMsg, undefined, "high risk plan must NOT auto-approve");

		await handlers.get("session_shutdown")?.({}, mockCtx);
	});
});
