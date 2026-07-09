/**
 * dag.ts — Pure DAG logic for plan step scheduling.
 *
 * Implements the Critical Path Method (CPM) from task-scheduling-formulas.md:
 *   - Parse plan markdown into a dependency DAG of PlanSteps.
 *   - Compute critical-path priorities (reverse-pass longest-path).
 *   - Identify ready steps (all predecessors done).
 *   - Build scoped prompts for sub-agents (step text + predecessor results only).
 *
 * All functions are pure and dependency-free for easy unit testing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "in_flight" | "done" | "failed";

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
}

// ---------------------------------------------------------------------------
// Plan → DAG parsing
// ---------------------------------------------------------------------------

/**
 * Match numbered plan steps with optional `(depends: N, M, ...)` annotations.
 *
 * Recognized formats:
 *   1. Some step text
 *   1. Some step text (depends: 2, 3)
 *   - [ ] 1. Some step text (depends: 2)
 *   1. **Bold step** (depends: 1, 2) — rest of text
 */
const STEP_RE = /^\s*(?:-\s*\[.\]\s*)?(\d+)[.)]\s+(.+)/;
const DEPENDS_RE = /\(depends?:\s*([\d,\s]+)\)/i;

/**
 * Parse plan markdown into a list of PlanSteps forming a dependency DAG.
 *
 * Strategy:
 *   - Extract numbered steps from the plan body.
 *   - Parse `(depends: N, M)` annotations if present.
 *   - If NO step has explicit dependencies, fall back to a linear chain
 *     (step N depends on step N-1) — preserves sequential correctness for
 *     plans written without dependency awareness.
 *   - Steps referencing non-existent predecessors are silently pruned.
 */
export function parsePlanToDAG(planMarkdown: string): PlanStep[] {
	const lines = planMarkdown.split("\n");
	const steps: PlanStep[] = [];
	let hasAnyAnnotation = false;

	for (const line of lines) {
		const match = line.match(STEP_RE);
		if (!match) continue;
		const id = parseInt(match[1] as string, 10);
		let text = (match[2] as string).trim();

		// Extract dependencies annotation
		const depMatch = text.match(DEPENDS_RE);
		let dependencies: number[] = [];
		if (depMatch) {
			hasAnyAnnotation = true;
			dependencies = (depMatch[1] as string)
				.split(",")
				.map((s) => parseInt(s.trim(), 10))
				.filter((n) => Number.isFinite(n) && n > 0);
			// Remove the annotation from displayed text
			text = text.replace(DEPENDS_RE, "").trim();
		}

		// Strip leading markdown bold markers for clean text
		text = text.replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim();

		steps.push({
			id,
			text,
			dependencies,
			weight: 1,
			status: "pending",
		});
	}

	// Validate: remove references to non-existent step IDs
	const validIds = new Set(steps.map((s) => s.id));
	for (const step of steps) {
		step.dependencies = step.dependencies.filter((d) => validIds.has(d) && d !== step.id);
	}

	// Fallback: if no step has explicit dependencies, assume linear chain
	if (!hasAnyAnnotation && steps.length > 1) {
		const sorted = [...steps].sort((a, b) => a.id - b.id);
		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1]!;
			const curr = sorted[i]!;
			curr.dependencies = [prev.id];
		}
	}

	return steps;
}

// ---------------------------------------------------------------------------
// Critical Path Method (CPM)
// ---------------------------------------------------------------------------

/**
 * Compute critical-path priority for each step in the DAG.
 *
 * CP(v) = max over successors w of [ weight(v→w) + CP(w) ]
 * Base case: terminal steps (no successors) have CP = 0.
 *
 * Returns a Map<stepId, cpPriority> where higher = dispatch first.
 * Complexity: O(|V| + |E|).
 */
export function computeCriticalPath(steps: PlanStep[]): Map<number, number> {
	const byId = new Map(steps.map((s) => [s.id, s]));

	// Build successor map: step → list of steps that depend on it
	const successors = new Map<number, number[]>();
	for (const step of steps) {
		if (!successors.has(step.id)) successors.set(step.id, []);
		for (const depId of step.dependencies) {
			const succs = successors.get(depId);
			if (succs) succs.push(step.id);
			else successors.set(depId, [step.id]);
		}
	}

	// Reverse topological pass (memoized DFS with cycle detection)
	const cp = new Map<number, number>();
	const visiting = new Set<number>();

	function computeCP(id: number): number {
		if (visiting.has(id)) {
			// Cycle detected! Return 0 and don't recurse.
			return 0;
		}
		const cached = cp.get(id);
		if (cached !== undefined) return cached;

		visiting.add(id);

		const succs = successors.get(id) ?? [];
		if (succs.length === 0) {
			visiting.delete(id);
			cp.set(id, 0);
			return 0;
		}

		let maxPath = 0;
		for (const succId of succs) {
			const succStep = byId.get(succId);
			const edgeWeight = succStep?.weight ?? 1;
			const path = edgeWeight + computeCP(succId);
			if (path > maxPath) maxPath = path;
		}
		visiting.delete(id);
		cp.set(id, maxPath);
		return maxPath;
	}

	for (const step of steps) {
		computeCP(step.id);
	}

	return cp;
}

// ---------------------------------------------------------------------------
// Ready-step detection
// ---------------------------------------------------------------------------

/**
 * Get steps that are ready to execute: status is "pending" and all
 * predecessors have status "done".
 *
 * Returns steps sorted by critical-path priority (highest first).
 */
export function getReadySteps(steps: PlanStep[], cpMap?: Map<number, number>): PlanStep[] {
	const statusById = new Map(steps.map((s) => [s.id, s.status]));

	const ready = steps.filter((s) => {
		if (s.status !== "pending") return false;
		return s.dependencies.every((depId) => statusById.get(depId) === "done");
	});

	if (cpMap) {
		ready.sort((a, b) => (cpMap.get(b.id) ?? 0) - (cpMap.get(a.id) ?? 0));
	}

	return ready;
}

// ---------------------------------------------------------------------------
// Scoped prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a focused prompt for a sub-agent executing a single plan step.
 *
 * The prompt contains ONLY:
 *   1. The step's own task text.
 *   2. Results from predecessor steps (so the sub-agent has the context it needs).
 *   3. A brief overall plan summary (for orientation, not full context).
 *
 * This is the core context-isolation mechanism: the sub-agent does NOT receive
 * the full parent conversation, only what's relevant to its specific task.
 */
/**
 * Helper to recursively find all transitive predecessor step IDs (ancestors) in the DAG.
 */
function getTransitiveAncestors(stepId: number, allSteps: PlanStep[]): Set<number> {
	const ancestors = new Set<number>();
	const byId = new Map(allSteps.map((s) => [s.id, s]));

	function dfs(id: number) {
		const step = byId.get(id);
		if (!step) return;
		for (const depId of step.dependencies) {
			if (!ancestors.has(depId)) {
				ancestors.add(depId);
				dfs(depId);
			}
		}
	}

	dfs(stepId);
	return ancestors;
}

/**
 * Build a focused prompt for a sub-agent executing a single plan step.
 *
 * The prompt contains:
 *   1. The step's own task text.
 *   2. Results from all transitive predecessor steps (ancestors) in dependency order.
 *   3. A brief overall plan summary.
 */
export function buildStepPrompt(
	step: PlanStep,
	allSteps: PlanStep[],
	predecessorResults: Map<number, string>,
	planSummary: string,
): string {
	const sections: string[] = [];

	// 1. Plan orientation (brief)
	sections.push(`# Plan Context\n\nYou are executing step ${step.id} of a multi-step implementation plan.\n\n${planSummary}`);

	// 2. Ancestor results (transitive dependencies) in execution/dependency order
	const ancestors = getTransitiveAncestors(step.id, allSteps);
	if (ancestors.size > 0) {
		const depResults: string[] = [];
		// Sort ancestors by ID to present them in natural chronological order
		const sortedAncestors = Array.from(ancestors).sort((a, b) => a - b);
		
		for (const depId of sortedAncestors) {
			const depStep = allSteps.find((s) => s.id === depId);
			const result = predecessorResults.get(depId);
			if (depStep) {
				const isDirect = step.dependencies.includes(depId);
				const relString = isDirect ? "Direct Prerequisite" : "Transitive Prerequisite";
				depResults.push(
					`## Step ${depId}: ${depStep.text} (${relString})\n${result ? `Result: ${result}` : "(completed, no detailed result)"}`,
				);
			}
		}
		if (depResults.length > 0) {
			sections.push(`# Prerequisite Step Results\n\nThese steps completed before yours and are relevant to your task:\n\n${depResults.join("\n\n")}`);
		}
	}

	// 3. The actual task
	sections.push(
		`# Your Task — Step ${step.id}\n\n${step.text}\n\n` +
		`Execute this step completely. When done, provide a concise summary of what you changed or accomplished.` +
		`\nDo NOT work on other steps — only step ${step.id}.`,
	);

	return sections.join("\n\n---\n\n");
}

/**
 * Extract a brief plan summary (first heading + first paragraph, or first 500 chars)
 * for use as orientation context in step prompts.
 */
export function extractPlanSummary(planMarkdown: string): string {
	const lines = planMarkdown.split("\n");
	const summary: string[] = [];
	let foundHeading = false;
	let charCount = 0;

	for (const line of lines) {
		if (charCount > 500) break;
		if (line.startsWith("#") && !foundHeading) {
			summary.push(line);
			foundHeading = true;
			continue;
		}
		if (foundHeading) {
			// Take lines until we hit the Tasks/Steps section
			if (/^#+\s*(tasks|steps|plan|implementation)/i.test(line)) break;
			summary.push(line);
			charCount += line.length;
		}
	}

	return summary.join("\n").trim() || planMarkdown.slice(0, 500);
}
