import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { registerTools, type ToolDeps } from "../tools.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = join(process.cwd(), `.tmp-tools-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(dir, { recursive: true });
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("update_tasks forwards the full task payload to the dependency callback", async () => {
	await withTempDir(async (dir) => {
		const tools = new Map<string, any>();
		const pi = {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;

		const updates: Array<{ done: number; total: number; items: Array<{ step: number; text: string; status: string }> }> = [];
		const deps = {
			getState: () => ({ phase: "EXECUTING", artifactDir: dir, interview: false }),
			setState: () => {},
			onPlanSubmitted: async () => {},
			onTasksUpdated: async (done: number, total: number, items?: Array<{ step: number; text: string; status: string }>) => {
				updates.push({ done, total, items: items ?? [] });
			},
			onWalkthroughWritten: async () => {},
		} as unknown as ToolDeps;

		registerTools(pi, deps);
		const tool = tools.get("update_tasks");
		assert.ok(tool, "update_tasks tool should be registered");

		await tool.execute(
			"task-id",
			{ items: [{ step: 1, text: "Inspect code", status: "done" }, { step: 2, text: "Refactor", status: "in_progress" }] },
			undefined,
			undefined,
			{ ui: { notify() {} } },
		);

		assert.equal(updates.length, 1);
		assert.equal(updates[0]!.done, 1);
		assert.equal(updates[0]!.total, 2);
		assert.equal(updates[0]!.items.length, 2);
		assert.equal(updates[0]!.items[0]!.text, "Inspect code");
	});
});
