import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parsePlanToDAG,
	computeCriticalPath,
	getReadySteps,
	buildStepPrompt,
	extractPlanSummary,
	type PlanStep,
} from "./dag.ts";
import { renderTasksMd } from "./utils.ts";

export class Dispatcher {
	private steps: PlanStep[] = [];
	private cpMap: Map<number, number> = new Map();
	private predecessorResults: Map<number, string> = new Map();
	private planSummary = "";
	private concurrencyLimit = 10;
	private activeSpawns = new Map<number, { id: string; promise: Promise<any> }>();

	constructor(
		private pi: ExtensionAPI,
		private ctx: ExtensionContext,
		private planMarkdown: string,
		private artifactDir: string,
		concurrencyLimit?: number,
	) {
		if (concurrencyLimit) {
			this.concurrencyLimit = Math.max(1, Math.min(32, concurrencyLimit));
		}
		this.steps = parsePlanToDAG(planMarkdown);
		this.cpMap = computeCriticalPath(this.steps);
		this.planSummary = extractPlanSummary(planMarkdown);
	}

	public async init(): Promise<void> {
		// Restore any previously completed step results from disk to support resume
		const resultsDir = join(this.artifactDir, "step-results");
		await mkdir(resultsDir, { recursive: true });

		for (const step of this.steps) {
			try {
				const resultPath = join(resultsDir, `step-${step.id}.md`);
				const content = await readFile(resultPath, "utf8");
				step.status = "done";
				step.result = content;
				this.predecessorResults.set(step.id, content);
			} catch {
				// File does not exist, step is not completed yet
			}
		}
	}

	public getSteps(): PlanStep[] {
		return this.steps;
	}

	public getStatus() {
		const done = this.steps.filter((s) => s.status === "done").length;
		const inFlight = this.steps.filter((s) => s.status === "in_flight").length;
		const failed = this.steps.filter((s) => s.status === "failed").length;
		const queued = this.steps.filter((s) => s.status === "pending").length;
		return {
			done,
			inFlight,
			failed,
			queued,
			total: this.steps.length,
			activeSpawns: Array.from(this.activeSpawns.keys()),
		};
	}

	public async dispatchReady(): Promise<boolean> {
		if (this.getStatus().inFlight >= this.concurrencyLimit) {
			return false;
		}

		const ready = getReadySteps(this.steps, this.cpMap);
		if (ready.length === 0) {
			return false;
		}

		let dispatchedAny = false;
		for (const step of ready) {
			if (this.getStatus().inFlight >= this.concurrencyLimit) {
				break;
			}
			dispatchedAny = true;
			void this.executeStep(step);
		}
		return dispatchedAny;
	}

	private async executeStep(step: PlanStep): Promise<void> {
		step.status = "in_flight";
		await this.updateTasksFile();

		const prompt = buildStepPrompt(step, this.steps, this.predecessorResults, this.planSummary);

		try {
			this.ctx.ui.notify(`[Antigravity Dispatcher] Spawning sub-agent for Step ${step.id}: ${step.text}`, "info");

			// Spawn sub-agent using the subagents extension API.
			// tsedr-runtime's global before_agent_start hook will run inside the sub-agent session.
			const agentResult = await (this.pi as any).callTool("Agent", {
				prompt,
				description: `Step ${step.id}: ${step.text.slice(0, 30)}`,
				subagent_type: "general-purpose",
				inherit_context: false, // Strict context isolation
				isolated: false,        // Let it modify files if needed
				run_in_background: false, // We run it in our own async execution block
			}) as { content: Array<{ type: string; text: string }> };

			const resultText = agentResult.content.map((c) => c.text).join("\n").trim();
			await this.onStepComplete(step.id, resultText);
		} catch (error: any) {
			await this.onStepFail(step.id, error?.message ?? String(error));
		}
	}

	private async onStepComplete(stepId: number, result: string): Promise<void> {
		const step = this.steps.find((s) => s.id === stepId);
		if (!step) return;

		step.status = "done";
		step.result = result;
		this.predecessorResults.set(stepId, result);

		// Persist step result to disk
		const resultsDir = join(this.artifactDir, "step-results");
		await writeFile(join(resultsDir, `step-${stepId}.md`), result, "utf8");

		this.ctx.ui.notify(`[Antigravity Dispatcher] Step ${stepId} completed successfully!`, "info");
		await this.updateTasksFile();

		// Trigger dispatch loop for any newly unblocked ready steps
		void this.dispatchReady();
	}

	private async onStepFail(stepId: number, error: string): Promise<void> {
		const step = this.steps.find((s) => s.id === stepId);
		if (!step) return;

		step.status = "failed";
		step.error = error;

		this.ctx.ui.notify(`[Antigravity Dispatcher] Step ${stepId} FAILED: ${error}`, "error");

		// Propagate failure to all downstream steps that depend on this one
		this.propagateFailure(stepId, error);

		await this.updateTasksFile();
	}

	private propagateFailure(failedId: number, error: string): void {
		for (const s of this.steps) {
			if (s.dependencies.includes(failedId) && s.status !== "failed") {
				s.status = "failed";
				s.error = `Prerequisite step ${failedId} failed: ${error}`;
				this.ctx.ui.notify(`[Antigravity Dispatcher] Cancelling Step ${s.id} because prerequisite Step ${failedId} failed.`, "warning");
				this.propagateFailure(s.id, error);
			}
		}
	}

	private async updateTasksFile(): Promise<void> {
		const tasksPath = join(this.artifactDir, "tasks.md");
		const items = this.steps.map((s) => ({
			step: s.id,
			text: s.text,
			status: s.status === "done" ? ("done" as const) : s.status === "in_flight" ? ("in_progress" as const) : s.status === "failed" ? ("failed" as const) : ("pending" as const),
		}));
		await writeFile(tasksPath, renderTasksMd(items), "utf8");
	}
}
