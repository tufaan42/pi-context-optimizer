/**
 * The 5-state machine for the pi-antigravity plan→review→execute→walkthrough loop.
 *
 *   INERT --/plan--> RESEARCHING --model.write_plan--> PLAN_DRAFTING --writes plan.md--> REVIEW_PENDING
 *   REVIEW_PENDING <--/reject-- (PLAN_DRAFTING)  |  <--approval=approved--> EXECUTING --all done + write_walkthrough--> INERT
 *
 * State lives in-memory in the extension; it is persisted into the session
 * JSONL via `pi.appendEntry("antigravity", …)` so `/resume` rebuilds it in
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

export interface AgState {
	phase: AgPhase;
	artifactDir: string | null;
	interview: boolean; // /grill active: one question at a time until /done
}

export interface AgPersisted {
	phase: AgPhase;
	artifactDir: string | null;
	interview: boolean;
}

export function defaultState(): AgState {
	return { phase: "INERT", artifactDir: null, interview: false };
}

export function toPersisted(s: AgState): AgPersisted {
	return { phase: s.phase, artifactDir: s.artifactDir, interview: s.interview };
}

export function fromPersisted(p: AgPersisted | undefined): AgState {
	if (!p) return defaultState();
	return { phase: p.phase, artifactDir: p.artifactDir, interview: !!p.interview };
}

/** status.json shape — the human/VS-Code-facing mirror. */
export interface StatusFile {
	phase: AgPhase;
	approval: Approval;
	reason?: string;
	done: number;
	total: number;
	updatedAt: string;
}

export function initialStatusFile(phase: AgPhase, total = 0, done = 0): StatusFile {
	return {
		phase,
		approval: phase === "REVIEW_PENDING" ? "pending" : "none",
		done,
		total,
		updatedAt: new Date().toISOString(),
	};
}