/**
 * The 5-state machine for the pi-context-optimizer plan→review→execute→walkthrough loop.
 *
 *   INERT --/plan--> RESEARCHING --model.write_plan--> PLAN_DRAFTING --writes plan.md--> REVIEW_PENDING
 *   REVIEW_PENDING <--/reject-- (PLAN_DRAFTING)  |  <--approval=approved--> EXECUTING --all done + write_walkthrough--> INERT
 *
 * State lives in-memory in the extension; it is persisted into the session
 * JSONL via `pi.appendEntry("context-optimizer", …)` so `/resume` rebuilds it in
 * `session_start`. The single source of truth at runtime is the `AgState`
 * object here; the `status.json` file is the *human-readable* mirror that the
 * file-watch and the VS Code approve/reject commands both write to.
 */

export type AgPhase =
	| "INERT"
	| "RESEARCHING"
	| "PLAN_DRAFTING"
	| "REVIEW_PENDING"
	| "EXECUTING";

export type Approval = "none" | "pending" | "approved" | "rejected";

export type AgTrack = "FAST" | "STANDARD" | "GATED";

export type ReviewMode = "auto" | "always" | "never";

export interface AgState {
	phase: AgPhase;
	artifactDir: string | null;
	interview: boolean; // /grill active: one question at a time until /done
	dispatcherActive?: boolean;
	track?: AgTrack;
	reviewMode?: ReviewMode;
	modifiedFiles?: string[];
}

export interface AgPersisted {
	phase: AgPhase;
	artifactDir: string | null;
	interview: boolean;
	dispatcherActive?: boolean;
	track?: AgTrack;
	reviewMode?: ReviewMode;
	modifiedFiles?: string[];
}

export function defaultState(): AgState {
	return {
		phase: "INERT",
		artifactDir: null,
		interview: false,
		dispatcherActive: false,
		track: "STANDARD",
		reviewMode: "auto",
		modifiedFiles: [],
	};
}

export function toPersisted(s: AgState): AgPersisted {
	return {
		phase: s.phase,
		artifactDir: s.artifactDir,
		interview: s.interview,
		dispatcherActive: s.dispatcherActive,
		track: s.track,
		reviewMode: s.reviewMode,
		modifiedFiles: s.modifiedFiles,
	};
}

export function fromPersisted(p: AgPersisted | undefined): AgState {
	if (!p) return defaultState();
	return {
		phase: p.phase,
		artifactDir: p.artifactDir,
		interview: !!p.interview,
		dispatcherActive: !!p.dispatcherActive,
		track: p.track ?? "STANDARD",
		reviewMode: p.reviewMode ?? "auto",
		modifiedFiles: p.modifiedFiles ?? [],
	};
}

/** status.json shape — the human/VS-Code-facing mirror. */
export interface StatusFile {
	phase: AgPhase;
	approval: Approval;
	track?: AgTrack;
	reviewMode?: ReviewMode;
	reason?: string;
	done: number;
	total: number;
	updatedAt: string;
}

export function initialStatusFile(
	phase: AgPhase,
	total = 0,
	done = 0,
	track?: AgTrack,
	reviewMode?: ReviewMode,
): StatusFile {
	return {
		phase,
		approval: phase === "REVIEW_PENDING" ? "pending" : "none",
		track,
		reviewMode,
		done,
		total,
		updatedAt: new Date().toISOString(),
	};
}