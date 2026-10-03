import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import contextOptimizerExtension from "../index.ts";
import { registerTools, type ToolDeps } from "../tools.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATUS_FILE, WALKTHROUGH_FILE } from "../utils.ts";
import type { AgState } from "../state.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = join(process.cwd(), `.tmp-fast-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(dir, { recursive: true });
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("contextOptimizerExtension registers /fast command and flags", () => {
	const registeredCommands = new Map<string, any>();
	const registeredFlags = new Map<string, any>();

	const mockPi = {
		registerFlag(name: string, opts: any) {
			registeredFlags.set(name, opts);
		},
		registerCommand(name: string, opts: any) {
			registeredCommands.set(name, opts);
		},
		registerTool() {},
		registerShortcut() {},
		on() {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;

	contextOptimizerExtension(mockPi);

	assert.ok(registeredCommands.has("fast"), "should register /fast command");
	assert.ok(registeredCommands.has("plan"), "should register /plan command");
	assert.ok(registeredFlags.has("ag-fast"), "should register --ag-fast flag");
	assert.ok(registeredFlags.has("ag-review"), "should register --ag-review flag");
});

test("write_walkthrough works cleanly in Fast Track without tasks.md", async () => {
	await withTempDir(async (dir) => {
		const tools = new Map<string, any>();
		const mockPi = {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;

		let state: AgState = {
			phase: "EXECUTING",
			artifactDir: dir,
			interview: false,
			track: "FAST",
			reviewMode: "auto",
			modifiedFiles: ["src/index.ts"],
		};

		let walkthroughWrittenCalled = false;
		const deps: ToolDeps = {
			getState: () => state,
			setState: (s) => {
				state = { ...state, ...s };
			},
			onPlanSubmitted: async () => {},
			onTasksUpdated: async () => {},
			onWalkthroughWritten: async () => {
				walkthroughWrittenCalled = true;
			},
		};

		registerTools(mockPi, deps);
		const walkthroughTool = tools.get("write_walkthrough");
		assert.ok(walkthroughTool);

		const result = await walkthroughTool.execute(
			"tool-call-1",
			{ content: "# Walkthrough\nFixed the bug successfully." },
			undefined,
			undefined,
			{ cwd: dir, ui: { notify() {} } },
		);

		assert.equal(state.phase, "INERT");
		assert.equal(walkthroughWrittenCalled, true);

		const written = await readFile(join(dir, WALKTHROUGH_FILE), "utf8");
		assert.ok(written.includes("Fixed the bug successfully."));
	});
});
