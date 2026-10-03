/**
 * sub-dispatcher.ts — Self-contained nested sub-dispatcher for DAG sub-graphs.
 *
 * A SubDispatcherNode manages an independent sub-graph of PlanSteps with its
 * own dispatch loop, retry logic, timeout handling, failure propagation, and
 * deadlock detection. It mirrors the core dispatch logic of the parent
 * Dispatcher without plan parsing, artifact directory, watchdog timer, or
 * tasks-file-update overhead.
 *
 * Events from the sub-dispatcher are relayed to the parent via the
 * parentMetrics callback in SubDispatcherConfig. The parent can then aggregate
 * metrics from all sub-dispatchers.
 *
 * Integration with the main Dispatcher:
 *   - The parent creates SubDispatcherNode instances via createSubDispatcher().
 *   - Sub-dispatchers are tracked in the parent's subDispatchers map.
 *   - Sub-dispatcher metrics are included in the parent's overall getMetrics().
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultSpawnAgent, type SpawnAgentFn } from "./dispatcher.ts";
import { getReadySteps, buildStepPrompt, extractStepResult, detectDeadlockedSteps, computeCriticalPath } from "./dag.ts";
import type { PlanStep, StepMetrics, DispatcherEvent, DispatcherEventType, DispatchStatus, SubDispatcherConfig } from "./types.ts";
import { emptyStepMetrics } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sub-agent spawn function signature matching the parent Dispatcher's type.
 */
type SubSpawnAgentFn = SpawnAgentFn;

// ---------------------------------------------------------------------------
// SubDispatcherNode
// ---------------------------------------------------------------------------

/**
 * Self-contained nested sub-dispatcher for DAG sub-graphs.
 *
 * Manages an independent set of PlanSteps with its own dispatch loop, retry
 * logic, timeout handling, failure propagation, and deadlock detection. Events
 * are relayed to the parent dispatcher via the parentMetrics callback.
 *
 * Typical usage:
 *
 *   const sub = new SubDispatcherNode(config, ctx, pi);
 *   const finalStatus = await sub.run();
 *   const metrics = sub.getMetrics();
 *
 * The parent Dispatcher can create SubDispatcherNodes for independent sub-graphs
 * and aggregate their metrics into its own reporting.
 */
export class SubDispatcherNode {
	private steps: PlanStep[];
	private config: SubDispatcherConfig;
	private spawnAgent: SubSpawnAgentFn;
	private ctx: ExtensionContext;
	private pi: ExtensionAPI;
	private cpMap: Map<number, number>;
	private predecessorResults: Map<number, string> = new Map();
	private stepTimeouts: Map<number, NodeJS.Timeout> = new Map();
	private metrics: Map<number, StepMetrics> = new Map();
	private stopped = false;
	private dispatching: Promise<void> = Promise.resolve();
	private lastDeadlockedCount = 0;
	private completionPromise: Promise<DispatchStatus>;
	private resolveCompletion!: (status: DispatchStatus) => void;

	constructor(
		config: SubDispatcherConfig,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		spawnAgent: SubSpawnAgentFn = defaultSpawnAgent,
	) {
		this.config = config;
		this.steps = config.steps;
		this.ctx = ctx;
		this.pi = pi;
		this.spawnAgent = spawnAgent;

		// Compute critical path for priority scheduling within the sub-graph
		this.cpMap = computeCriticalPath(this.steps);

		// Create a completion promise — resolved in checkCompletion() once all
		// steps have reached a terminal state.
		this.completionPromise = new Promise<DispatchStatus>((resolve) => {
			this.resolveCompletion = resolve;
		});
	}

	// -------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------

	/**
	 * Start executing the sub-graph. Returns a promise that resolves when all
	 * steps have reached a terminal state (done or failed).
	 *
	 * The resolved DispatchStatus reflects the final state of the sub-graph.
	 */
	public async run(): Promise<DispatchStatus> {
		this.emitEvent("drain_completed", undefined, {
			action: "sub_dispatcher_started",
			stepCount: this.steps.length,
			subGraphIds: this.steps.map((s) => s.id),
		});

		// Kick off the initial dispatch pass. The drain loop inside
		// dispatchReady handles all subsequent work, and checkCompletion
		// resolves the promise when execution finishes.
		void this.dispatchReady();

		return this.completionPromise;
	}

	/**
	 * Stop execution immediately. Prevents further dispatch and clears all
	 * pending step timeouts.
	 */
	public stop(): void {
		this.stopped = true;
		for (const [stepId, timeoutId] of this.stepTimeouts) {
			clearTimeout(timeoutId);
		}
		this.stepTimeouts.clear();
	}

	/**
	 * Return a snapshot of all collected step metrics for this sub-graph.
	 */
	public getMetrics(): StepMetrics[] {
		return Array.from(this.metrics.values());
	}

	/**
	 * Return the current execution status snapshot of the sub-graph.
	 */
	public getStatus(): DispatchStatus {
		const done = this.steps.filter((s) => s.status === "done").length;
		const inFlight = this.steps.filter((s) => s.status === "in_flight").length;
		const failed = this.steps.filter((s) => s.status === "failed").length;
		const queued = this.steps.filter((s) => s.status === "pending").length;
		return { done, inFlight, failed, queued, total: this.steps.length };
	}

	/**
	 * Access the managed steps (for parent to inspect sub-graph state).
	 */
	public getSteps(): PlanStep[] {
		return this.steps;
	}

	/**
	 * True if all steps in the sub-graph have reached a terminal state.
	 */
	public get isComplete(): boolean {
		const status = this.getStatus();
		return status.done + status.failed >= status.total;
	}

	// -------------------------------------------------------------------
	// Private: event emission
	// -------------------------------------------------------------------

	/**
	 * Emit a lifecycle event via the parentMetrics callback.
	 * Each event is tagged with `subDispatcher: true` so the parent can
	 * distinguish sub-dispatcher events from its own.
	 */
	private emitEvent(
		type: DispatcherEventType,
		stepId?: number,
		payload?: Record<string, unknown>,
	): void {
		if (!this.config.parentMetrics) return;
		this.config.parentMetrics({
			type,
			timestamp: Date.now(),
			stepId,
			payload: { ...payload, subDispatcher: true },
		});
	}

	// -------------------------------------------------------------------
	// Private: dispatch loop
	// -------------------------------------------------------------------

	/**
	 * Dispatch all ready steps, respecting the concurrency limit.
	 * Serialized via a promise chain so overlapping calls queue rather than race.
	 */
	private dispatchReady(): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			if (this.stopped) return false;
			let dispatchedAny = false;

			// Drain loop: dispatch all ready steps up to the concurrency cap.
			while (!this.stopped) {
				const status = this.getStatus();
				if (status.inFlight >= this.config.concurrencyLimit) break;
				const ready = getReadySteps(this.steps, this.cpMap);
				if (ready.length === 0) break;

				const slotsAvailable = this.config.concurrencyLimit - status.inFlight;
				const batch = ready.slice(0, slotsAvailable);
				for (const step of batch) {
					dispatchedAny = true;
					void this.executeStep(step);
				}
			}

			this.checkDeadlock();
			return dispatchedAny;
		};

		const result = this.dispatching.then(run, run);
		this.dispatching = result.then(() => undefined, () => undefined);
		return result;
	}

	// -------------------------------------------------------------------
	// Private: step execution with retry + timeout
	// -------------------------------------------------------------------

	/**
	 * Execute a single step by spawning a sub-agent, with retry and timeout.
	 *
	 * Implements the same T-SEDR 3-strike re-mutation loop as the parent
	 * Dispatcher:
	 *   - Promise.race between the spawnAgent and a timeout rejection.
	 *   - Retry loop with exponential backoff (retryDelayMs * retryCount).
	 *   - Metrics tracking for each attempt.
	 *   - Emits step_started / step_timed_out / step_failed events.
	 */
	private async executeStep(step: PlanStep): Promise<void> {
		// Idempotency guard: prevent double-spawn before status flips
		if (step.status !== "pending") return;
		step.status = "in_flight";

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

		const prompt = buildStepPrompt(
			step,
			this.steps,
			this.predecessorResults,
			this.config.planSummary,
			this.config.gateCommand,
		);

		const stepId = step.id;
		const maxRetries = this.config.maxRetries;
		const timeoutMs = this.config.timeoutMs;
		const retryDelayMs = this.config.retryDelayMs;
		let lastError: string | undefined;

		// T-SEDR 3-strike re-mutation loop
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				step.status = "in_flight";
			}

			this.ctx.ui.notify(
				`[SubDispatcher] Spawning sub-agent for Step ${stepId} (attempt ${attempt + 1}/${maxRetries + 1}): ${step.text}`,
				"info",
			);

			try {
				// Race the sub-agent spawn against a timeout rejection.
				const runResult = await Promise.race([
					this.spawnAgent(
						this.ctx,
						step.agent ?? "worker",
						prompt,
						{
							pi: this.pi,
							inheritContext: false,
							isolated: false,
							depth: 2, // depth 2: sub-agent of a nested sub-dispatcher
							model: this.ctx.model,
						},
					),
					new Promise<never>((_, reject) => {
						const timeoutId = setTimeout(() => {
							this.emitEvent("step_timed_out", stepId, { timeoutMs });
							reject(
								new Error(
									`[SubDispatcher] Step ${stepId} timed out after ${timeoutMs}ms`,
								),
							);
						}, timeoutMs);
						this.stepTimeouts.set(stepId, timeoutId);
					}),
				]);

				// Success: sub-agent completed before timeout
				this.clearStepTimeout(stepId);
				const resultText = extractStepResult(runResult.responseText);
				await this.onStepComplete(stepId, resultText);
				return;
			} catch (error: any) {
				this.clearStepTimeout(stepId);
				lastError = error?.message ?? String(error);

				if (attempt < maxRetries) {
					step.retryCount = (step.retryCount ?? 0) + 1;
					const delay = retryDelayMs * step.retryCount;
					this.ctx.ui.notify(
						`[SubDispatcher] Step ${stepId} failed on attempt ${attempt + 1}/${maxRetries + 1}: ${lastError}. Retrying in ${delay}ms...`,
						"warning",
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}

				// All retries exhausted — T-SEDR 3-strike limit reached
				await this.onStepFail(stepId, lastError!);
				return;
			}
		}
	}

	/**
	 * Clear and remove any pending timeout for the given step.
	 */
	private clearStepTimeout(stepId: number): void {
		const existing = this.stepTimeouts.get(stepId);
		if (existing) {
			clearTimeout(existing);
			this.stepTimeouts.delete(stepId);
		}
	}

	// -------------------------------------------------------------------
	// Private: completion/failure handlers
	// -------------------------------------------------------------------

	/**
	 * Handle successful step completion: update status, record metrics, persist
	 * result, check for deadlocks, and re-invoke dispatch for newly-ready steps.
	 */
	private async onStepComplete(stepId: number, result: string): Promise<void> {
		const step = this.steps.find((s) => s.id === stepId);
		if (!step) return;

		step.status = "done";
		step.result = result;
		this.predecessorResults.set(stepId, result);

		const sMetrics = this.metrics.get(stepId);
		if (sMetrics) {
			sMetrics.completedAt = Date.now();
			sMetrics.durationMs =
				sMetrics.startedAt !== null
					? sMetrics.completedAt - sMetrics.startedAt
					: null;
		}
		this.emitEvent("step_completed", stepId, {
			durationMs: sMetrics?.durationMs ?? null,
		});

		this.ctx.ui.notify(
			`[SubDispatcher] Step ${stepId} completed successfully!`,
			"info",
		);

		// A completion may unblock new steps — check deadlock, re-dispatch
		this.checkDeadlock();
		void this.dispatchReady();
		this.checkCompletion();
	}

	/**
	 * Handle step failure: update status, record metrics, propagate failure
	 * downstream, and re-evaluate completion.
	 */
	private async onStepFail(stepId: number, error: string): Promise<void> {
		const step = this.steps.find((s) => s.id === stepId);
		if (!step) return;

		step.status = "failed";
		step.error = error;

		const sMetrics = this.metrics.get(stepId);
		if (sMetrics) {
			sMetrics.completedAt = Date.now();
			sMetrics.durationMs =
				sMetrics.startedAt !== null
					? sMetrics.completedAt - sMetrics.startedAt
					: null;
			sMetrics.lastError = error;
		}
		this.emitEvent("step_failed", stepId, {
			durationMs: sMetrics?.durationMs ?? null,
			error,
		});

		this.ctx.ui.notify(
			`[SubDispatcher] Step ${stepId} FAILED: ${error}`,
			"error",
		);

		// Propagate failure to all downstream steps that depend on this one
		this.propagateFailure(stepId, error);
		this.checkDeadlock();
		this.checkCompletion();
	}

	/**
	 * Propagate failure downstream through the sub-graph DAG using iterative
	 * (stack-based) traversal instead of recursion, preventing stack overflow
	 * on deep dependency chains.
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
						`[SubDispatcher] Cancelling Step ${s.id} because prerequisite Step ${currentId} failed.`,
						"warning",
					);
					stack.push(s.id);
				}
			}
		}
	}

	/**
	 * Check for deadlocked steps within the sub-graph. Pending steps whose
	 * transitive predecessors are all failed are marked as failed so they
	 * don't block execution indefinitely.
	 *
	 * Only emits notifications when the deadlock count changes, preventing
	 * repeated noise.
	 */
	private checkDeadlock(): void {
		if (this.stopped) return;
		const deadlockedIds = detectDeadlockedSteps(this.steps);
		if (deadlockedIds.length === 0) {
			this.lastDeadlockedCount = 0;
			return;
		}

		for (const id of deadlockedIds) {
			const step = this.steps.find((s) => s.id === id);
			if (!step || step.status !== "pending") continue;
			step.status = "failed";
			step.error =
				"Deadlock detected: all transitive predecessors have failed, step cannot become ready.";
		}

		if (deadlockedIds.length !== this.lastDeadlockedCount) {
			this.lastDeadlockedCount = deadlockedIds.length;
			this.emitEvent("deadlock_detected", undefined, { deadlockedIds });
			this.ctx.ui.notify(
				`[SubDispatcher] Deadlock detected: ${deadlockedIds.length} step(s) blocked by failed prerequisites. Steps: ${deadlockedIds.join(", ")}`,
				"warning",
			);
		}
	}

	/**
	 * Check if all steps in the sub-graph have reached a terminal state.
	 * When they have, stop the sub-dispatcher and resolve the completion promise.
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
				subDispatcher: true,
			});
			this.resolveCompletion(status);
		}
	}
}
