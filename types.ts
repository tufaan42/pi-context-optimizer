/**
 * types.ts — Foundation types for pi-context-optimizer
 *
 * Canonical home for all shared domain types. Modules import from here rather
 * than redefining their own versions, ensuring type consistency across the
 * dispatcher, DAG, state machine, tools, and bridge layers.
 *
 * Types are organized by logical domain:
 *   1. Phase & Status — step execution lifecycle + agent state machine
 *   2. Step / Task / DAG — plan steps, tasks, configuration
 *   3. Dispatcher — spawn function, status snapshots, sub-dispatcher config
 *   4. Timeout / Retry / Gate — retry policy, invariants gate results
 *   5. Metrics / Observability — per-step runtime metrics
 *   6. Event system — typed events for dispatcher lifecycle (nested dispatchers)
 *   7. State machine — AgState, AgPersisted, StatusFile
 *   8. Bridge / Host — active.json pointer, HTTP bridge config
 *   9. Defaults / Helpers — factory functions with sensible defaults
 */

// =========================================================================
// 1. Phase & Status
// =========================================================================

/** Execution status of a single step in the dependency DAG. */
export type StepStatus = "pending" | "in_flight" | "done" | "failed";

/** The 5-phase state machine for the plan -> review -> execute -> walkthrough loop. */
export type AgPhase =
	| "INERT"
	| "RESEARCHING"
	| "PLAN_DRAFTING"
	| "REVIEW_PENDING"
	| "EXECUTING";

/** Approval state for the human review gate. */
export type Approval = "none" | "pending" | "approved" | "rejected";

// =========================================================================
// 2. Step / Task / DAG
// =========================================================================

/** Per-step configuration for timeout and retry behaviour. */
export interface StepConfig {
	/** Maximum wall-clock time (ms) before a step is considered timed out. */
	timeoutMs: number;
	/** Number of automatic retries on failure (0 = no retry, 2 = 3 total attempts). */
	maxRetries: number;
	/** Base delay (ms) between retries (actual delay = baseDelayMs * retryCount). */
	retryDelayMs: number;
}

/**
 * A single step in the plan dependency DAG.
 *
 * Compared to the original definition in dag.ts this extended version adds:
 *   - `retryCount` / `config` for the T-SEDR 3-strike retry loop.
 */
export interface PlanStep {
	/** 1-based step number from the plan. */
	id: number;
	/** The step's description text. */
	text: string;
	/** IDs of steps that must complete before this one. */
	dependencies: number[];
	/** Estimated complexity weight (default 1). */
	weight: number;
	/** Current execution status. */
	status: StepStatus;
	/** Result text from the sub-agent (set after completion). */
	result?: string;
	/** Error message if the step failed. */
	error?: string;
	/** Number of automatic retries attempted so far (0 = first attempt, 1 = first retry). */
	retryCount?: number;
	/** Per-step configuration — overrides global defaults when set. */
	config?: StepConfig;
	/** Optional sub-agent type to execute this step (e.g. "worker", "reviewer", "scout", "oracle"). */
	agent?: string;
}

/** Renderable task item for tasks.md checklist rendering. */
export interface TaskItem {
	/** 1-based step number. */
	step: number;
	/** Short step description. */
	text: string;
	/** Current status (includes "failed" for the tasks.md renderer). */
	status: "pending" | "in_progress" | "done" | "failed";
	/** IDs of prerequisite steps. */
	dependencies?: number[];
}

// =========================================================================
// 3. Dispatcher
// =========================================================================

/**
 * Sub-agent spawn function signature (injectable for testing).
 *
 * The original definition in dispatcher.ts is extended here to include
 * `model`, `thinking`, and `maxTurns` — these MUST be propagated explicitly
 * across the Agent-tool boundary so nested sub-agents inherit the same model
 * and thinking tier as their parent.
 */
export type SpawnAgentFn = (
	ctx: any,
	type: string,
	prompt: string,
	options: {
		pi: any;
		inheritContext: boolean;
		isolated: boolean;
		depth: number;
		/** Model string (e.g. "anthropic/claude-sonnet-4-20250514") propagated to children. */
		model?: string;
		/** Thinking level ("off" | "minimal" | "low" | "medium" | "high" | "xhigh"). */
		thinking?: string;
		/** Maximum agentic turns for the spawned sub-agent. */
		maxTurns?: number;
	},
) => Promise<{ responseText: string; aborted: boolean }>;

/** Aggregate dispatcher execution status snapshot. */
export interface DispatchStatus {
	done: number;
	inFlight: number;
	failed: number;
	queued: number;
	total: number;
}

/** Configuration for a SubDispatcherNode managing an independent sub-graph. */
export interface SubDispatcherConfig {
	/** Sub-graph steps to manage. */
	steps: PlanStep[];
	/** Detected invariants gate command (or null). */
	gateCommand: string | null;
	/** Max concurrent sub-agent spawns within this sub-dispatcher. */
	concurrencyLimit: number;
	/** Step timeout in milliseconds. */
	timeoutMs: number;
	/** Maximum retries per step. */
	maxRetries: number;
	/** Base retry delay in milliseconds. */
	retryDelayMs: number;
	/** Brief plan summary for sub-agent orientation context. */
	planSummary: string;
	/** Optional callback for feeding lifecycle events back to the parent dispatcher. */
	parentMetrics?: (event: DispatcherEvent) => void;
}

// =========================================================================
// 4. Timeout / Retry / Gate
// =========================================================================

/** Kinds of invariants-gate violations that can be reported. */
export type GateViolationKind = "exit_code" | "timeout" | "output_mismatch";

/** Structured result of running the project's invariants gate on a step's output. */
export interface GateResult {
	/** True if the gate passed (exit code 0, no violations). */
	passed: boolean;
	/** The kind of violation when `passed` is false. */
	kind: GateViolationKind | null;
	/** Shell exit code (null if the gate couldn't be run). */
	exitCode: number | null;
	/** Human-readable diagnostic message when the gate fails. */
	diagnostic: string | null;
}

// =========================================================================
// 5. Metrics / Observability
// =========================================================================

/** Per-step runtime metrics collected by the dispatcher during execution. */
export interface StepMetrics {
	/** The step ID these metrics belong to. */
	stepId: number;
	/** Epoch ms when the step was first dispatched (null = not yet started). */
	startedAt: number | null;
	/** Epoch ms when the step completed or failed (null = still running). */
	completedAt: number | null;
	/** Wall-clock duration in ms (null = not yet finished). */
	durationMs: number | null;
	/** Number of spawn attempts (incremented on each attempt including retries). */
	spawnCount: number;
	/** Error message from the last failed attempt (null = no error). */
	lastError: string | null;
}

// =========================================================================
// 6. Event system (nested dispatchers + observability)
// =========================================================================

/** Discriminated event types emitted by the dispatcher lifecycle. */
export type DispatcherEventType =
	| "step_started"
	| "step_completed"
	| "step_failed"
	| "step_retrying"
	| "step_timed_out"
	| "deadlock_detected"
	| "drain_completed"
	| "dispatcher_stopped";

/** An event emitted by the dispatcher during execution. */
export interface DispatcherEvent {
	/** Discriminated event type. */
	type: DispatcherEventType;
	/** Epoch ms when the event was emitted. */
	timestamp: number;
	/** Optional step ID the event relates to. */
	stepId?: number;
	/** Arbitrary additional payload (retry count, error message, metrics, etc.). */
	payload?: Record<string, unknown>;
}

// =========================================================================
// 7. State machine (from state.ts)
// =========================================================================

/** In-memory state of the context-optimizer state machine. */
export interface AgState {
	/** Current phase of the 5-state loop. */
	phase: AgPhase;
	/** Absolute path to the session artifact directory. */
	artifactDir: string | null;
	/** True when in /grill interview mode. */
	interview: boolean;
	/** True when the DAG dispatcher is actively running. */
	dispatcherActive?: boolean;
}

/** Persistable snapshot of AgState for session resume. */
export interface AgPersisted {
	phase: AgPhase;
	artifactDir: string | null;
	interview: boolean;
	dispatcherActive?: boolean;
}

/** Shape of status.json — the human/VS-Code-facing mirror of execution progress. */
export interface StatusFile {
	/** Current agent phase. */
	phase: AgPhase;
	/** Current approval state. */
	approval: Approval;
	/** Rejection reason (set when approval === "rejected"). */
	reason?: string;
	/** Number of completed steps. */
	done: number;
	/** Total number of steps. */
	total: number;
	/** ISO timestamp of the last update. */
	updatedAt: string;
}

// =========================================================================
// 8. Bridge / Host
// =========================================================================

/** Shape of active.json — the stable host-discovery pointer. */
export interface ActivePointer {
	/** Absolute path to the active session's artifact directory. */
	artifactDir: string;
	/** Current phase (mirrors status.json). */
	phase: string;
	/** Approval state (mirrors status.json). */
	approval: string;
	/** Completed step count. */
	done: number;
	/** Total step count. */
	total: number;
	/** ISO timestamp of the last update. */
	updatedAt: string;
}

/** Input for writeActivePointer (updatedAt is stamped internally, not supplied by caller). */
export interface ActivePointerInput {
	artifactDir: string;
	phase: string;
	approval: string;
	done: number;
	total: number;
}

/** HTTP bridge configuration for the optional VS Code / host integration. */
export interface BridgeConfig {
	/** Base URL of the bridge HTTP endpoint. */
	url: string;
	/** Authentication token. */
	token: string;
	/** HTTP header name carrying the token. */
	authHeader: string;
}

/** Result of an open-artifact-in-editor attempt. */
export type OpenResult = "opened" | "skipped";

// =========================================================================
// 9. Defaults / Helpers
// =========================================================================

/**
 * Sensible defaults for step execution configuration.
 *
 * These align with T-SEDR's 3-strike re-mutation rule:
 *   - `timeoutMs` = 300 000 (5 min) — matches a typical sub-agent task window.
 *   - `maxRetries` = 2 — first attempt + 2 retries = 3 total strikes.
 *   - `retryDelayMs` = 2 000 — brief backoff before re-dispatch.
 */
export function defaultStepConfig(): StepConfig {
	return {
		timeoutMs: 300_000,
		maxRetries: 2,
		retryDelayMs: 2_000,
	};
}

/**
 * Create an initial StatusFile for a given phase.
 *
 * This mirrors the `initialStatusFile` in state.ts but is defined here as the
 * canonical factory since StatusFile lives here.
 */
export function initialStatusFile(phase: AgPhase, total = 0, done = 0): StatusFile {
	return {
		phase,
		approval: phase === "REVIEW_PENDING" ? "pending" : "none",
		done,
		total,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Create a zeroed StepMetrics entry for a step ID.
 */
export function emptyStepMetrics(stepId: number): StepMetrics {
	return {
		stepId,
		startedAt: null,
		completedAt: null,
		durationMs: null,
		spawnCount: 0,
		lastError: null,
	};
}
