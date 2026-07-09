/**
 * Model-callable tools for the pi-antigravity loop.
 *
 *   write_plan         — RESEARCHING/PLAN_DRAFTING only. Writes plan.md, opens
 *                        it in VS Code, flips state → REVIEW_PENDING, and tells
 *                        the LLM to STOP and wait for /approve.
 *   update_tasks       — EXECUTING only. Rewrites tasks.md checklist; returns
 *                        remaining/done counts. Honors `[DONE:n]` markers in
 *                        assistant turns via index.ts's turn_end hook too.
 *   write_walkthrough  — EXECUTING-end. Writes walkthrough.md, opens it,
 *                        returns state to INERT.
 *   write_knowledge_item — phase-2 stub: appends to <artifactDir>/knowledge/.
 *
 * All file writes go through `withFileMutationQueue` so they share the per-file
 * queue with pi's built-in edit/write tool (no torn writes between us and the
 * agent if both touch the same file).
 *
 * Enum params use `StringEnum` (not Type.Union/Literal) for Google API compat,
 * per docs/extensions.md.
 *
 * Tools throw to signal errors (returning a value never sets isError=true).
 */

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	PLAN_FILE,
	TASKS_FILE,
	WALKTHROUGH_FILE,
	KNOWLEDGE_DIR,
	renderTasksMd,
	type TaskItem,
} from "./utils.ts";
import { openArtifactInVSCode, pushPlanStatusToVSCode } from "./open.ts";
import type { AgState } from "./state.ts";

// Re-export the registration entrypoint so index.ts can call registerTools(pi, getState, setState, ...)
export interface ToolDeps {
	getState: () => AgState;
	setState: (next: AgState) => void;
	/** Called after write_plan to refresh the status.json file + watcher. */
	onPlanSubmitted: () => Promise<void>;
	/** Called after update_tasks to reflect counts into status.json. */
	onTasksUpdated: (done: number, total: number) => Promise<void>;
	/** Called after write_walkthrough to reset status. */
	onWalkthroughWritten: () => Promise<void>;
	/** Get active dispatcher status if running. */
	getDispatcherStatus?: () => { done: number; inFlight: number; failed: number; queued: number; total: number } | null;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
	registerWritePlan(pi, deps);
	registerUpdateTasks(pi, deps);
	registerWalkthrough(pi, deps);
	registerKnowledgeItem(pi, deps);
	registerDispatchStatus(pi, deps);
}

function ok(text: string, extra?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details: extra ?? {} };
}

// ---------------------------------------------------------------------------
// write_plan
// ---------------------------------------------------------------------------

function registerWritePlan(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "write_plan",
		label: "Write Plan",
		description:
			"Write the implementation plan to the plan.md artifact for this session. " +
			"Use this ONLY during the research/plan phase. The plan will be opened in VS Code for " +
			"human review; you MUST then STOP and wait — do not edit any code until the user " +
			"approves (the gate blocks edit/write/bash-mutation). Do NOT call write_plan again " +
			"after approval.",
		promptSnippet: "Write the human-reviewable implementation plan to disk",
		promptGuidelines: [
			"Use write_plan to publish the implementation plan as a reviewable file. " +
				"After write_plan returns, stop and wait for human approval before editing code.",
			"Design the plan with numbered tasks. If a task depends on other tasks, explicitly " +
				"annotate it in the step text using the format: `Step N (depends: X, Y): task description`. " +
				"This allows the task scheduler to run independent tasks in parallel.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "Full markdown body of the plan." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = deps.getState();
			if (s.phase !== "RESEARCHING" && s.phase !== "PLAN_DRAFTING" && s.phase !== "REVIEW_PENDING") {
				throw new Error(
					`write_plan is only valid during RESEARCHING/PLAN_DRAFTING (current: ${s.phase}).`,
				);
			}
			if (!s.artifactDir) throw new Error("No artifact directory for this session.");

			const planPath = join(s.artifactDir, PLAN_FILE);
			await withFileMutationQueue(planPath, async () => {
				await mkdir(dirname(planPath), { recursive: true });
				await writeFile(planPath, ensurePlanHeader(params.content), "utf8");
			});
			void openArtifactInVSCode(pi, planPath, true);

			// Transition → REVIEW_PENDING; persist; refresh status.json + watcher.
			deps.setState({ ...s, phase: "REVIEW_PENDING" });
			await deps.onPlanSubmitted();
			ctx.ui.notify("Plan submitted for review. Open plan.md in VS Code; /approve to begin.", "info");
			return ok(
				`Plan written to ${planPath} and opened in VS Code.\n` +
					"Awaiting human review. STOP now — do not edit code. Wait for /approve.",
				{ planPath },
			);
		},
	});
}

// ---------------------------------------------------------------------------
// update_tasks
// ---------------------------------------------------------------------------

function registerUpdateTasks(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "update_tasks",
		label: "Update Tasks",
		description:
			"Update the live tasks.md checklist during EXECUTING. Pass the full ordered list of " +
			"tasks with their current status. Call this after completing each step so progress is " +
			"reflected live in VS Code.",
		promptSnippet: "Maintain the live task checklist during execution",
		promptGuidelines: [
			"Use update_tasks after each step of the approved plan to keep tasks.md current. " +
				"Pass the entire ordered task list with statuses.",
		],
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					step: Type.Integer({ description: "1-based step number." }),
					text: Type.String({ description: "Short step description." }),
					status: StringEnum(["pending", "in_progress", "done"] as const),
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = deps.getState();
			if (s.phase !== "EXECUTING") {
				throw new Error(`update_tasks is only valid during EXECUTING (current: ${s.phase}).`);
			}
			if (!s.artifactDir) throw new Error("No artifact directory for this session.");

			const tasksPath = join(s.artifactDir, TASKS_FILE);
			const items = (params.items ?? []) as TaskItem[];
			await withFileMutationQueue(tasksPath, async () => {
				await mkdir(dirname(tasksPath), { recursive: true });
				await writeFile(tasksPath, renderTasksMd(items), "utf8");
			});
			void openArtifactInVSCode(pi, tasksPath, false);

			const done = items.filter((t) => t.status === "done").length;
			await deps.onTasksUpdated(done, items.length);
			return ok(`tasks.md updated (${done}/${items.length} done).`, { done, total: items.length });
		},
	});
}

// ---------------------------------------------------------------------------
// write_walkthrough
// ---------------------------------------------------------------------------

function registerWalkthrough(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "write_walkthrough",
		label: "Write Walkthrough",
		description:
			"Write the post-execution walkthrough.md summary (diffs, results, verification). " +
			"Call this once when execution of the approved plan is complete. Resets the loop to inert.",
		promptSnippet: "Publish the post-execution walkthrough summary",
		promptGuidelines: [
			"Use write_walkthrough exactly once at the end of execution to summarize what changed " +
				"and how it was verified.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "Full markdown body of the walkthrough." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = deps.getState();
			if (s.phase !== "EXECUTING") {
				throw new Error(`write_walkthrough is only valid during EXECUTING (current: ${s.phase}).`);
			}
			if (!s.artifactDir) throw new Error("No artifact directory for this session.");

			const wtPath = join(s.artifactDir, WALKTHROUGH_FILE);
			await withFileMutationQueue(wtPath, async () => {
				await mkdir(dirname(wtPath), { recursive: true });
				await writeFile(wtPath, params.content, "utf8");
			});
			void openArtifactInVSCode(pi, wtPath, false);

			deps.setState({ ...s, phase: "INERT", interview: false });
			await deps.onWalkthroughWritten();
			ctx.ui.notify("Walkthrough written. Plan loop complete.", "info");
			return ok(`Walkthrough written to ${wtPath}. Loop reset to inert.`, { walkthroughPath: wtPath });
		},
	});
}

// ---------------------------------------------------------------------------
// write_knowledge_item (phase-2 stub: append-only to knowledge/<slug>.md)
// ---------------------------------------------------------------------------

function registerKnowledgeItem(pi: ExtensionAPI, _deps: ToolDeps): void {
	pi.registerTool({
		name: "write_knowledge_item",
		label: "Write Knowledge Item",
		description:
			"Append a curated Knowledge Item (note for future sessions) to the project's knowledge " +
			"store under <artifactDir>/knowledge/. Phase 2: these are not yet auto-loaded on session " +
			"start — only persisted.",
		promptSnippet: "Persist a Knowledge Item for future sessions",
		promptGuidelines: [
			"Use write_knowledge_item to record durable cross-session knowledge (patterns, gotchas, " +
				"decisions) discovered during research or execution.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short title." }),
			body: Type.String({ description: "Markdown body." }),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const s = _deps.getState();
			if (!s.artifactDir) throw new Error("No artifact directory for this session.");
			const dir = join(s.artifactDir, KNOWLEDGE_DIR);
			const slug = String(params.title ?? "item")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 60) || "item";
			const path = join(dir, `${slug}.md`);
			const frontmatter = `---\ntitle: ${JSON.stringify(params.title)}\ntags: ${JSON.stringify(params.tags ?? [])}\ndate: ${new Date().toISOString()}\n---\n\n`;
			await withFileMutationQueue(path, async () => {
				await mkdir(dirname(path), { recursive: true });
				await appendFile(path, frontmatter + String(params.body) + "\n\n", "utf8");
			});
			return ok(`Knowledge item appended to ${path}.`, { knowledgePath: path });
		},
	});
}

// ---------------------------------------------------------------------------
// dispatch_status
// ---------------------------------------------------------------------------

function registerDispatchStatus(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "dispatch_status",
		label: "Dispatch Status",
		description: "Query the status of the DAG task dispatcher during EXECUTING phase.",
		promptSnippet: "Get DAG execution progress",
		promptGuidelines: [
			"Use dispatch_status to check which steps are done, in-flight, failed, or queued."
		],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const s = deps.getState();
			if (s.phase !== "EXECUTING") {
				throw new Error("dispatch_status is only valid during EXECUTING phase.");
			}
			if (deps.getDispatcherStatus) {
				const status = deps.getDispatcherStatus();
				if (status) {
					return ok(`Dispatcher status: ${status.done}/${status.total} done (${status.inFlight} in-flight, ${status.queued} queued, ${status.failed} failed).`, status);
				}
			}
			return ok("No active dispatcher running.");
		}
	});
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ensurePlanHeader(content: string): string {
	if (/^#\s+/m.test(content)) return content;
	return `# Implementation Plan\n\n${content}`;
}