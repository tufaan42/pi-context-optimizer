/**
 * dispatcher.ts — DAG task dispatcher (the "middleman").
 *
 * When a plan is approved, the engine compiles the steps into a Directed
 * Acyclic Graph (DAG) and executes independent branches concurrently using
 * the Structured Delegation API from `pi-subagents` (nicobailon/pi-subagents).
 *
 * Key design decisions:
 *   - **Structured Delegation via pi.events**: pi-subagents provides the
 *     `prompt-template:subagent:request` protocol. We emit requests on pi.events
 *     and listen for terminal responses. If pi-subagents is not active in the
 *     current session, we seamlessly fall back to an isolated AgentSession.
 *     root cause of every step failing instantly.
 *   - **Strict context isolation**: each sub-agent is spawned with
 *     `inheritContext: false` and receives only a scoped prompt (step text +
 *     predecessor results + nesting protocol + gate).
 *   - **Self-similar nesting protocol**: every step prompt includes the full
 *     protocol (built via buildNestingProtocol), which the sub-agent is told
 *     to propagate verbatim to its own nested spawns — so recursion works
 *     without the dispatcher
 *     pre-planning every level.
 *   - **Structured result contract**: sub-agents end with a `=== STEP RESULT ===`
 *     block; `extractStepResult` pulls just that block so dependent prompts
 *     stay lean.
 *   - **Hardened dispatch loop**: idempotency guard (no double-spawn),
 *     serialized re-entrancy lock (no overlapping dispatch passes), drain loop
 *     (keep dispatching until no ready steps or cap saturated), and a watchdog
 *     timer that recovers from lost completion callbacks.
 *   - **Resume validation**: `init()` demotes any `done` step whose
 *     predecessors are not all `done` back to `pending`, preventing ordering
 *     inversions after a crash/restart.
 */

import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, createAgentSession } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationTerminalResponse,
} from "pi-subagents/delegation";
import {
	parsePlanToDAG,
	computeCriticalPath,
	getReadySteps,
	buildStepPrompt,
	extractPlanSummary,
	extractStepResult,
	detectDeadlockedSteps,
} from "./dag.ts";
import type { PlanStep } from "./types.ts";
import { detectInvariantsGate } from "./utils.ts";
import { renderTasksMd } from "./utils.ts";
import { type StepConfig, defaultStepConfig, type StepMetrics, emptyStepMetrics, type DispatcherEvent, type DispatcherEventType, type DispatchStatus, type SubDispatcherConfig } from "./types.ts";
import { SubDispatcherNode } from "./sub-dispatcher.ts";

const WATCHDOG_INTERVAL_MS = 5000;

/**
 * Type of the injectable sub-agent spawn function. Tests pass a stub; the
 * default delegates to runAgent from @tintinweb/pi-subagents.
 */
/**
 * Sub-agent spawn function signature (injectable for testing).
 *
 * The model from the parent session (ExtensionContext.model) is passed
 * explicitly as `options.model` so the spawned child inherits the same model.
 * `runAgent` from pi-subagents already falls back to ctx.model when
 * options.model is absent, but passing it explicitly makes the contract visible
 * and ensures the type system enforces propagation when overriding spawnAgent.
 *
 * `thinkingLevel` is NOT automatically inherited from the parent context
 * because ExtensionContext does not expose a thinking-level property. It must
 * be set explicitly or left undefined to inherit the agent type's default.
 * This is a known gap; when ExtensionContext gains a thinking-level accessor,
 * the dispatcher should read it here and pass it through.
 */
export type SpawnAgentFn = (
	ctx: ExtensionContext,
	type: string,
	prompt: string,
	options: {
		pi: ExtensionAPI;
		inheritContext: boolean;
		isolated: boolean;
		depth: number;
		/** Parent session model object — passed explicitly so children inherit it. */
		model?: Model<any>;
		/** Thinking level override. Omit to inherit agent type's default. */
		thinkingLevel?: ThinkingLevel;
		/** Maximum agentic turns before forced wrap-up. */
		maxTurns?: number;
	},
) => Promise<{ responseText: string; aborted: boolean }>;

/**
 * Direct fallback execution using pi's createAgentSession when pi-subagents
 * is not actively handling delegation events on pi.events.
 */
async function runDirectAgentSession(
	ctx: ExtensionContext,
	prompt: string,
	options: { model?: Model<any>; thinkingLevel?: ThinkingLevel },
): Promise<{ responseText: string; aborted: boolean }> {
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		...(options.model ? { model: options.model } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	});
	try {
		await session.prompt(prompt);
		const messages = session.messages;
		const lastMsg = messages[messages.length - 1];
		let responseText = "";
		if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
			responseText = lastMsg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		}
		return { responseText, aborted: false };
	} finally {
		await session.dispose();
	}
}

/** Default spawn implementation — delegates to pi-subagents with seamless direct fallback. */
export const defaultSpawnAgent: SpawnAgentFn = async (ctx, type, prompt, options) => {
	const mappedAgent = (type === "general-purpose" || !type) ? "worker" : type;
	const requestId = crypto.randomUUID();
	const ownerRunId = `plan-run-${Date.now()}`;
	const nodeId = `step-${requestId.slice(0, 8)}`;

	let started = false;
	const unsubStarted = options.pi.events.on(SUBAGENT_DELEGATION_STARTED_EVENT, (payload: any) => {
		if (payload?.requestId === requestId) {
			started = true;
		}
	});

	const responseDeferred = new Promise<{ responseText: string; aborted: boolean }>((resolve, reject) => {
		const unsubResponse = options.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload: any) => {
			const resp = payload as SubagentDelegationTerminalResponse;
			if (resp?.requestId !== requestId) return;
			unsubResponse();
			unsubStarted();

			if (resp.status === "completed") {
				const responseText = resp.result?.kind === "text"
					? resp.result.text
					: (resp.result?.kind === "structured" ? JSON.stringify(resp.result.value) : "");
				resolve({ responseText, aborted: false });
			} else if (resp.status === "cancelled") {
				resolve({ responseText: "", aborted: true });
			} else {
				reject(new Error(resp.error ?? `Subagent delegation ended with status: ${resp.status}`));
			}
		});
	});

	const req: SubagentDelegationRequest = {
		requestId,
		ownerRunId,
		nodeId,
		agent: mappedAgent,
		task: prompt,
		context: options.inheritContext ? "fork" : "fresh",
		cwd: ctx.cwd,
		...(options.model?.id ? { model: options.model.id } : {}),
		result: { kind: "text" },
	};

	options.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, req);

	if (!started) {
		unsubStarted();
		return runDirectAgentSession(ctx, prompt, { model: options.model, thinkingLevel: options.thinkingLevel });
	}

	return responseDeferred;
};

export class Dispatcher {
	private steps: PlanStep[] = [];
	private cpMap: Map<number, number> = new Map();
	private predecessorResults: Map<number, string> = new Map();
	private planSummary = "";
	private gateCommand: string | null = null;
	private concurrencyLimit = 10;
	private dispatching: Promise<void> = Promise.resolve();
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private lastDeadlockedCount = 0;
	private pi: ExtensionAPI;
	private ctx: ExtensionContext;
	private planMarkdown: string;
	private artifactDir: string;
	private spawnAgent: SpawnAgentFn;
	private stepTimeouts: Map<number, NodeJS.Timeout> = new Map();
	private defaultStepCfg: StepConfig;
	private timeoutMs: number;
	private metrics: Map<number, StepMetrics> = new Map();
	private subDispatchers: Map<number, SubDispatcherNode> = new Map();
	private onEventCallback?: (event: DispatcherEvent) => void;
	private onAllDoneCb?: (status: DispatchStatus) => void;
	private onStatusChangeCb?: (done: number, total: number) => void | Promise<void>;

	constructor(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		planMarkdown: string,
		artifactDir: string,
		concurrencyLimit?: number,
		timeoutMs?: number,
		spawnAgent: SpawnAgentFn = defaultSpawnAgent,
		onEvent?: (event: DispatcherEvent) => void,
		onAllDone?: (status: DispatchStatus) => void,
		onStatusChange?: (done: number, total: number) => void | Promise<void>,
		defaultConfig?: Partial<StepConfig>,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.planMarkdown = planMarkdown;
		this.artifactDir = artifactDir;
		this.spawnAgent = spawnAgent;
		this.onEventCallback = onEvent;
		this.onAllDoneCb = onAllDone;
		this.onStatusChangeCb = onStatusChange;
		this.timeoutMs = timeoutMs ?? 300_000;
		this.defaultStepCfg = { ...defaultStepConfig(), ...defaultConfig };
		if (timeoutMs !== undefined) {
			this.defaultStepCfg.timeoutMs = timeoutMs;
		}
		if (concurrencyLimit) {
			this.concurrencyLimit = Math.max(1, Math.min(32, concurrencyLimit));
		}
		this.steps = parsePlanToDAG(planMarkdown);
		this.cpMap = computeCriticalPath(this.steps);
		this.planSummary = extractPlanSummary(planMarkdown);
		this.gateCommand = detectInvariantsGate(ctx.cwd);
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

		// Resume validation: demote any "done" step whose predecessors are NOT
		// all "done" back to "pending". This prevents an ordering inversion where
		// a predecessor's result file was lost and the predecessor would be
		// re-dispatched AFTER its dependent already finished.
		for (const step of this.steps) {
			if (step.status === "done") {
				const predsDone = step.dependencies.every((depId) => {
					const dep = this.steps.find((s) => s.id === depId);
					return dep?.status === "done";
				});
				if (!predsDone) {
					step.status = "pending";
					step.result = undefined;
					this.predecessorResults.delete(step.id);
				}
			}
		}

		// Start the watchdog timer to recover from lost completion callbacks
		this.startWatchdog();

		// Kick off the initial dispatch
		void this.dispatchReady();
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
		};
	}

	/** Return a snapshot of all collected step metrics, including from sub-dispatchers. */
	public getMetrics(): StepMetrics[] {
		const allMetrics = Array.from(this.metrics.values());
		for (const [, sub] of this.subDispatchers) {
			allMetrics.push(...sub.getMetrics());
		}
		return allMetrics;
	}

	/**
	 * Create and register a nested SubDispatcherNode for an independent sub-graph.
	 *
	 * Extracts the specified steps (by ID) from the current plan, constructs a
	 * SubDispatcherConfig using the parent's settings (concurrency, timeout,
	 * retry), and wires the parentMetrics callback so sub-dispatcher lifecycle
	 * events flow into the parent's event stream.
	 *
	 * The created sub-dispatcher is NOT automatically started — call `.run()` on
	 * the returned SubDispatcherNode to begin execution.
	 *
	 * @param stepIds - IDs of the steps to include in the sub-graph.
	 * @param configOverride - Optional overrides for the sub-dispatcher config.
	 * @returns The newly created SubDispatcherNode (not yet started).
	 */
	public createSubDispatcher(
		stepIds: number[],
		configOverride?: Partial<SubDispatcherConfig>,
	): SubDispatcherNode {
		// Extract the requested steps (preserving DAG relationships between them)
		const subSteps = this.steps.filter((s) => stepIds.includes(s.id));
		if (subSteps.length === 0) {
			throw new Error(`No steps found for sub-dispatcher with IDs: ${stepIds.join(", ")}`);
		}

		// Detect any external dependencies (steps outside the sub-graph that the
		// sub-graph steps depend on). These cannot be satisfied within the
		// sub-dispatcher and would cause deadlock — warn the caller.
		const externalDeps = new Set<number>();
		for (const step of subSteps) {
			for (const depId of step.dependencies) {
				if (!stepIds.includes(depId)) {
					externalDeps.add(depId);
				}
			}
		}
		if (externalDeps.size > 0) {
			this.ctx.ui.notify(
				`[Dispatcher] Warning: sub-dispatcher steps depend on external steps ${Array.from(externalDeps).join(", ")}. ` +
				`These must complete before the sub-dispatcher starts.`, "warning",
			);
		}

		const subConfig: SubDispatcherConfig = {
			steps: subSteps,
			gateCommand: this.gateCommand,
			concurrencyLimit: configOverride?.concurrencyLimit ?? this.concurrencyLimit,
			timeoutMs: configOverride?.timeoutMs ?? this.timeoutMs,
			maxRetries: configOverride?.maxRetries ?? this.defaultStepCfg.maxRetries,
			retryDelayMs: configOverride?.retryDelayMs ?? this.defaultStepCfg.retryDelayMs,
			planSummary: configOverride?.planSummary ?? this.planSummary,
			parentMetrics: (event) => {
				// Relay sub-dispatcher events to the parent's event callback
				if (this.onEventCallback) {
					this.onEventCallback(event);
				}
			},
		};

		const subNode = new SubDispatcherNode(subConfig, this.ctx, this.pi, this.spawnAgent as any);

		// Track the sub-dispatcher; clean up when it completes or fails
		const subId = stepIds[0]!; // use first step ID as the sub-dispatcher key (non-null: we checked length above)
		this.subDispatchers.set(subId, subNode);

		return subNode;
	}

	/** Stop the watchdog and prevent further dispatch. Called on walkthrough/reset/shutdown. */
	public stop(): void {
		this.stopped = true;
		// Stop all active sub-dispatchers
		for (const [, sub] of this.subDispatchers) {
			sub.stop();
		}
		this.subDispatchers.clear();
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	private async writeStatusFile(): Promise<void> {
		if (!this.onStatusChangeCb) return;
		const status = this.getStatus();
		await this.onStatusChangeCb(status.done, status.total);
	}

	private emitEvent(type: DispatcherEventType, stepId?: number, payload?: Record<string, unknown>): void {
		if (!this.onEventCallback) return;
		this.onEventCallback({
			type,
			timestamp: Date.now(),
			stepId,
			payload,
		});
	}

	private startWatchdog(): void {
		if (this.watchdogTimer) return;
		this.watchdogTimer = setInterval(() => {
			if (this.stopped) return;
			// Run deadlock detection BEFORE the completion check because
			// checkDeadlock can mark pending steps as failed. If we checked
			// completion first, newly deadlocked steps would be missed and
			// the watchdog would only stop on the next tick (5s delay).
			this.checkDeadlock();
			// Re-invoke dispatch to recover from any lost completion callback.
			// dispatchReady may also cause new failures (via propagateFailure
			// in executeStep), so we check completion after it resolves.
			void this.dispatchReady().then(() => {
				this.checkCompletion();
			}, () => {
				this.checkCompletion();
			});
		}, WATCHDOG_INTERVAL_MS);
	}

	/**
	 * Dispatch all ready steps, respecting the concurrency limit.
	 * Serialized via a promise chain so overlapping calls (from completions,
	 * the watchdog, or init) queue rather than race.
	 */
	public dispatchReady(): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			if (this.stopped) return false;
			let dispatchedAny = false;
			// Drain loop: dispatch all ready steps up to the concurrency cap.
			// Since executeStep sets step.status = "in_flight" synchronously before
			// its first await, the in-flight count is immediately reflected in the
			// next iteration's getStatus() call. The slotsAvailable is derived from
			// the live inFlight count (not a local counter) so it correctly prevents
			// over-saturation even when steps from a previous dispatchReady call are
			// still in-flight.
			while (!this.stopped) {
				const status = this.getStatus();
				if (status.inFlight >= this.concurrencyLimit) break;
				const ready = getReadySteps(this.steps, this.cpMap);
				if (ready.length === 0) break;

				const slotsAvailable = this.concurrencyLimit - status.inFlight;
				const batch = ready.slice(0, slotsAvailable);
				for (const step of batch) {
					dispatchedAny = true;
					void this.executeStep(step);
				}
			}
			// Check for deadlocks after each dispatch pass
			this.checkDeadlock();
			return dispatchedAny;
		};

		// Serialize: chain onto the previous dispatchReady call
		const result = this.dispatching.then(run, run);
		this.dispatching = result.then(() => undefined, () => undefined);
		return result;
	}

	private async executeStep(step: PlanStep): Promise<void> {
		// Idempotency guard: if two dispatch passes race, only the first proceeds.
		// This prevents double-spawning a step before its status flips to in_flight.
		if (step.status !== "pending") return;
		step.status = "in_flight";
		await this.updateTasksFile();
		await this.writeStatusFile();

		// Initialize/update runtime metrics for this step
		let metrics = this.metrics.get(step.id);
		if (!metrics) {
			metrics = emptyStepMetrics(step.id);
			this.metrics.set(step.id, metrics);
		}
		if (metrics.startedAt === null) {
			metrics.startedAt = Date.now();
		}
		metrics.spawnCount += 1;
		this.emitEvent("step_started", step.id, { attempt: metrics.spawnCount });

		const prompt = buildStepPrompt(step, this.steps, this.predecessorResults, this.planSummary, this.gateCommand);

		const stepId = step.id;

		// Resolve per-step config: individual step overrides take precedence
		// over the shared defaultStepCfg (which itself can be overridden via
		// the constructor's timeoutMs parameter).
		const stepCfg = step.config ?? this.defaultStepCfg;
		const maxRetries = stepCfg.maxRetries;

		let lastError: string | undefined;

		// T-SEDR 3-strike re-mutation loop:
		//   - attempt 0 = first try
		//   - attempts 1..maxRetries = retries after failure
		//   - total attempts = maxRetries + 1
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			// If this is a retry, re-set the status (was set to "in_flight" before
			// the first attempt, but a prior failure or timeout flipped it to
			// "failed" via onStepFail when retries exhausted — on retry we reset it).
			if (attempt > 0) {
				step.status = "in_flight";
				await this.updateTasksFile();
			}

			const timeoutMs = stepCfg.timeoutMs;

			this.ctx.ui.notify(
				`[Context Optimizer Dispatcher] Spawning sub-agent for Step ${stepId} (attempt ${attempt + 1}/${maxRetries + 1}): ${step.text}`,
				"info",
			);

			try {
				// Race the sub-agent spawn against a timeout rejection.
				// Using Promise.race avoids the two-phase "timedOut flag + late
				// callback" problem: when the timeout wins, the race rejects with
				// a clean error that the single catch block below handles uniformly
				// with any other spawn error — including retry decisions.
				const runResult = await Promise.race([
					this.spawnAgent(
						this.ctx,
						step.agent ?? "worker",
						prompt,
						{
							pi: this.pi,
							inheritContext: false,
							isolated: false,
							depth: 1,
							// Propagate parent session model explicitly so the child
							// agent inherits the same model (e.g. sonnet-4, haiku-4-5).
							// runAgent already falls back to ctx.model when this is
							// absent (via resolveDefaultModel), but passing it here
							// makes the contract visible and type-enforced.
							model: this.ctx.model,
							// thinkingLevel is omitted because ExtensionContext does
							// not expose a thinking-level accessor. When it does,
							// plumb it through as `thinkingLevel: this.ctx.thinkingLevel`.
						},
					),
					// Timeout promise: rejects when the wall-clock limit expires.
					// We register the timer handle in this.stepTimeouts so that
					// clearStepTimeout() can clean it up if the spawn wins the race.
					new Promise<never>((_, reject) => {
						const timeoutId = setTimeout(() => {
							this.emitEvent("step_timed_out", stepId, { timeoutMs });
							reject(new Error(`Step ${stepId} timed out after ${timeoutMs}ms`));
						}, timeoutMs);
						this.stepTimeouts.set(stepId, timeoutId);
					}),
				]);

				// Success path: the sub-agent completed before the timeout.
				// Clear the pending timeout (the losing promise's setTimeout) and
				// finalize the step.
				this.clearStepTimeout(stepId);
				const resultText = extractStepResult(runResult.responseText);
				await this.onStepComplete(stepId, resultText);
				return;
			} catch (error: any) {
				// Either the spawnAgent rejected, or the timeout won the race.
				// Clear any pending timeout handle before deciding retry vs fail.
				this.clearStepTimeout(stepId);
				lastError = error?.message ?? String(error);

				if (attempt < maxRetries) {
					// Retry: increment retry counter, apply exponential backoff,
					// and loop back to re-spawn.
					step.retryCount = (step.retryCount ?? 0) + 1;
					const delay = stepCfg.retryDelayMs * step.retryCount;
					this.ctx.ui.notify(
						`[Context Optimizer Dispatcher] Step ${stepId} failed on attempt ${attempt + 1}/${maxRetries + 1}: ${lastError}. Retrying in ${delay}ms...`,
						"warning",
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}

				// All retries exhausted — T-SEDR 3-strike limit reached.
				// Fail the step permanently; the propagated failure will cascade
				// to downstream steps via onStepFail -> propagateFailure.
				await this.onStepFail(stepId, lastError!);
				return;
			}
		}
	}

	private clearStepTimeout(stepId: number): void {
		const existing = this.stepTimeouts.get(stepId);
		if (existing) {
			clearTimeout(existing);
			this.stepTimeouts.delete(stepId);
		}
	}

	private async onStepComplete(stepId: number, result: string): Promise<void> {
		const step = this.steps.find((s) => s.id === stepId);
		if (!step) return;

		step.status = "done";
		step.result = result;
		this.predecessorResults.set(stepId, result);

		// Record completion metrics
		const sMetrics = this.metrics.get(stepId);
		if (sMetrics) {
			sMetrics.completedAt = Date.now();
			sMetrics.durationMs = sMetrics.startedAt !== null ? sMetrics.completedAt - sMetrics.startedAt : null;
		}
		this.emitEvent("step_completed", stepId, { durationMs: sMetrics?.durationMs ?? null });

		// Persist step result to disk
		const resultsDir = join(this.artifactDir, "step-results");
		await writeFile(join(resultsDir, `step-${stepId}.md`), result, "utf8");

		this.ctx.ui.notify(`[Context Optimizer Dispatcher] Step ${stepId} completed successfully!`, "info");
		await this.updateTasksFile();
		await this.writeStatusFile();

		// A completion may unblock new steps — check for deadlocks first
		this.checkDeadlock();

		// Trigger dispatch loop for any newly unblocked ready steps
		void this.dispatchReady();

		// Check if all steps are now terminal (done + failed === total).
		// This fires the onAllDone callback and stops the watchdog proactively,
		// rather than waiting for the next watchdog tick (up to 5s delay).
		this.checkCompletion();
	}

	private async onStepFail(stepId: number, error: string): Promise<void> {
		const step = this.steps.find((s) => s.id === stepId);
		if (!step) return;

		step.status = "failed";
		step.error = error;

		// Record failure metrics
		const sMetrics = this.metrics.get(stepId);
		if (sMetrics) {
			sMetrics.completedAt = Date.now();
			sMetrics.durationMs = sMetrics.startedAt !== null ? sMetrics.completedAt - sMetrics.startedAt : null;
			sMetrics.lastError = error;
		}
		this.emitEvent("step_failed", stepId, { durationMs: sMetrics?.durationMs ?? null, error });

		this.ctx.ui.notify(`[Context Optimizer Dispatcher] Step ${stepId} FAILED: ${error}`, "error");

		// Propagate failure to all downstream steps that depend on this one
		this.propagateFailure(stepId, error);

		// A failure may cause downstream deadlocks — check immediately
		this.checkDeadlock();

		await this.updateTasksFile();
		await this.writeStatusFile();

		// Check if all steps are now terminal (done + failed === total).
		// This fires the onAllDone callback and stops the watchdog proactively,
		// rather than waiting for the next watchdog tick (up to 5s delay).
		this.checkCompletion();
	}

	/**
	 * Propagate failure downstream through the DAG using an iterative (stack-based)
	 * traversal instead of recursion, preventing stack overflow on deep dependency chains.
	 */
	private propagateFailure(failedId: number, error: string): void {
		const stack = [failedId];
		const visited = new Set<number>();

		while (stack.length > 0) {
			const currentId = stack.pop()!;
			if (visited.has(currentId)) continue;
			visited.add(currentId);

			for (const s of this.steps) {
				if (s.dependencies.includes(currentId) && s.status !== "failed") {
					s.status = "failed";
					s.error = `Prerequisite step ${currentId} failed: ${error}`;
					this.ctx.ui.notify(
						`[Context Optimizer Dispatcher] Cancelling Step ${s.id} because prerequisite Step ${currentId} failed.`,
						"warning",
					);
					stack.push(s.id);
				}
			}
		}
	}

	/**
	 * Check for deadlocked steps — pending steps whose transitive predecessors
	 * are all failed. Such steps can never become ready and would block execution
	 * indefinitely. When detected, they are marked as failed with a deadlock error.
	 *
	 * Uses iterative ancestor traversal (via detectDeadlockedSteps from dag.ts)
	 * to avoid stack overflow on deeply nested DAGs.
	 *
	 * Only emits notifications when the deadlock count changes, preventing
	 * repeated noise on every watchdog tick.
	 */
	private checkDeadlock(): void {
		if (this.stopped) return;
		const deadlockedIds = detectDeadlockedSteps(this.steps);
		if (deadlockedIds.length === 0) {
			this.lastDeadlockedCount = 0;
			return;
		}

		// Mark deadlocked steps as failed
		for (const id of deadlockedIds) {
			const step = this.steps.find((s) => s.id === id);
			if (!step || step.status !== "pending") continue;
			step.status = "failed";
			step.error = `Deadlock detected: all transitive predecessors have failed, step cannot become ready.`;
		}

		// Only notify on changes to avoid log spam
		if (deadlockedIds.length !== this.lastDeadlockedCount) {
			this.lastDeadlockedCount = deadlockedIds.length;
			this.ctx.ui.notify(
				`[Context Optimizer Dispatcher] Deadlock detected: ${deadlockedIds.length} step(s) blocked by failed prerequisites. Steps: ${deadlockedIds.join(", ")}`,
				"warning",
			);
			// Update tasks file and status.json to reflect deadlock failures
			void this.updateTasksFile();
			void this.writeStatusFile();
		}
	}

	/**
	 * Check if all steps have reached a terminal state (done or failed).
	 *
	 * When all steps are terminal:
	 *   1. Stops the watchdog timer.
	 *   2. Emits a "dispatcher_stopped" event with the final status.
	 *   3. Invokes the optional onAllDone callback so the owning code
	 *      (index.ts) can react to completion or total failure proactively,
	 *      rather than waiting for the next LLM turn's agent_end handler.
	 *
	 * Called from onStepComplete, onStepFail, and the watchdog timer.
	 * Safe to call repeatedly — the stopped flag prevents re-invocation.
	 */
	private checkCompletion(): void {
		if (this.stopped) return;
		const status = this.getStatus();
		if (status.done + status.failed >= status.total) {
			this.stop();
			this.emitEvent("dispatcher_stopped", undefined, {
				done: status.done,
				failed: status.failed,
				total: status.total,
			});
			if (status.failed > 0) {
				this.ctx.ui.notify(
					`[Context Optimizer Dispatcher] All steps complete: ${status.done} done, ${status.failed} failed.` +
					(status.failed === status.total ? " Total failure." : " Partial failure."),
					status.failed === status.total ? "error" : "warning",
				);
			}
			this.onAllDoneCb?.(status);
		}
	}

	private async updateTasksFile(): Promise<void> {
		if (this.stopped) return;
		try {
			const tasksPath = join(this.artifactDir, "tasks.md");
			const items = this.steps.map((s) => ({
				step: s.id,
				text: s.text,
				status: s.status === "done" ? ("done" as const) : s.status === "in_flight" ? ("in_progress" as const) : s.status === "failed" ? ("failed" as const) : ("pending" as const),
			}));
			await writeFile(tasksPath, renderTasksMd(items), "utf8");
		} catch {
			// defensive: directory may have been cleaned up during shutdown
		}
	}
}
