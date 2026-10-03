/**
 * dag.ts — Pure DAG logic for plan step scheduling.
 *
 * Implements the Critical Path Method (CPM):
 *   - Parse plan markdown into a dependency DAG of PlanSteps.
 *   - Compute critical-path priorities (reverse-pass longest-path).
 *   - Identify ready steps (all predecessors done).
 *   - Build scoped prompts for sub-agents (step text + predecessor results only).
 *   - Extract structured step results for lean context propagation.
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
	/** Optional sub-agent type to execute this step (e.g. "worker", "reviewer", "scout", "oracle"). */
	agent?: string;
}

// ---------------------------------------------------------------------------
// Result contract — structured output from every sub-agent
// ---------------------------------------------------------------------------

export const STEP_RESULT_OPEN = "=== STEP RESULT (Step";
export const STEP_RESULT_CLOSE = "=== END STEP RESULT ===";

/**
 * Extract the structured result block from a sub-agent's raw output.
 *
 * Sub-agents are instructed to end their work with:
 *   === STEP RESULT (Step N) ===
 *   <concise summary>
 *   === END STEP RESULT ===
 *
 * If the block is present, only its inner content is returned (keeps
 * dependent-step prompts lean). If absent, the full text is returned as a
 * fallback so no information is lost.
 */
export function extractStepResult(raw: string): string {
	const openIdx = raw.indexOf(STEP_RESULT_OPEN);
	if (openIdx === -1) return raw.trim();
	const afterOpen = raw.indexOf("===", openIdx + STEP_RESULT_OPEN.length);
	if (afterOpen === -1) return raw.trim();
	const contentStart = afterOpen + 3;
	const closeIdx = raw.indexOf(STEP_RESULT_CLOSE, contentStart);
	if (closeIdx === -1) return raw.trim();
	return raw.slice(contentStart, closeIdx).trim() || raw.trim();
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
 *   ### Step 1 — Some step text (depends: 2, 3)        [heading form]
 *   ### Step 1: Some step text (depends: 2)             [heading form]
 */
const STEP_RE = /^\s*(?:-\s*\[.\]\s*)?(?:#+\s*)?(?:Step\s+)?(\d+)[.)\s:—–-]+\s*(.+)/i;
const DEPENDS_RE = /\(depends?:\s*([\d,\s]+)\)/i;
const AGENT_RE = /\(agent:\s*([a-zA-Z0-9_-]+)\)/i;

/**
 * Parse plan markdown into a list of PlanSteps forming a dependency DAG.
 *
 * Strategy:
 *   - Extract numbered steps from the plan body (both `N. text` list form and
 *     `### Step N — text` heading form).
 *   - Parse `(depends: N, M)` annotations if present.
 *   - If NO step has explicit dependencies, fall back to a linear chain
 *     (step N depends on step N-1) — preserves sequential correctness for
 *     plans written without dependency awareness.
 *   - Steps referencing non-existent predecessors are silently pruned.
 *   - Duplicate step IDs are merged (first occurrence wins; later headings
 *     with the same number are skipped).
 */
export function parsePlanToDAG(planMarkdown: string): PlanStep[] {
	const lines = planMarkdown.split("\n");
	const steps: PlanStep[] = [];
	const seenIds = new Set<number>();
	let hasAnyAnnotation = false;

	for (const line of lines) {
		const match = line.match(STEP_RE);
		if (!match) continue;
		const id = parseInt(match[1] as string, 10);
		if (seenIds.has(id)) continue; // skip duplicate step numbers
		let text = (match[2] as string).trim();

		let dependencies: number[] = [];
		let agent: string | undefined;

		// Extract annotations from any parenthesized blocks like (agent: worker, depends: 1) or (agent: scout) or (depends: 2, 3)
		const ANNOTATION_BLOCK_RE = /\(([^)]+)\)/g;
		text = text.replace(ANNOTATION_BLOCK_RE, (fullMatch, inner) => {
			let handled = false;
			const depMatch = inner.match(/depends?:\s*([\d,\s]+)/i);
			if (depMatch) {
				hasAnyAnnotation = true;
				handled = true;
				dependencies = (depMatch[1] as string)
					.split(",")
					.map((s) => parseInt(s.trim(), 10))
					.filter((n) => Number.isFinite(n) && n > 0);
			}
			const agentMatch = inner.match(/agent:\s*([a-zA-Z0-9_-]+)/i);
			if (agentMatch) {
				handled = true;
				agent = (agentMatch[1] as string).toLowerCase();
			}
			return handled ? "" : fullMatch;
		}).trim();

		// Strip leading colons/dashes leftover from removing leading annotations like "(agent: scout): text"
		text = text.replace(/^[:—–-]\s*/, "").trim();

		// Strip leading markdown bold markers for clean text
		text = text.replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim();
		// Strip trailing dependency-notes like *(depends: ...)* or *(no deps)*
		text = text.replace(/\*\(.*\)\*$/, "").trim();

		seenIds.add(id);
		steps.push({
			id,
			text,
			dependencies,
			weight: 1,
			status: "pending",
			...(agent ? { agent } : {}),
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
// buildNestingProtocol — construct self-propagating sub-agent protocol
// ---------------------------------------------------------------------------

/**
 * Build the self-similar Nested Sub-Agent Protocol, embedding the project's
 * verification gate command so it propagates verbatim to grandchildren.
 *
 * The gate command is a project-level constant (detected once per plan), so the
 * same command reaches every nesting level when sub-agents copy this protocol
 * verbatim into their own children's prompts.
 */
export function buildNestingProtocol(gateCommand: string | null = null): string {
	const gateSection = gateCommand
		? `## 5. Verification Gate\n\nBefore declaring your work done, run this verification gate command and fix any errors. If it fails, fix the errors and re-run until it passes:\n\n\`\`\`bash\n${gateCommand}\n\`\`\``
		: `## 5. Verification Gate\n\nNo automated gate command was detected for this project. Before declaring your work done, self-verify by re-reading your changes and confirming they are correct.`;

	return `
You are running as an autonomous sub-agent inside a DAG-dispatched execution pipeline.
You have access to the full set of tools, including the **Agent** tool, which lets you
spawn your own nested sub-agents. Follow this protocol:

## 1. Assess decomposability
Before doing any work, assess whether your task can be decomposed into independent
sub-tasks. A task is decomposable if it has 2+ independent parts that can be worked
on in parallel (e.g., editing different files, researching different areas).

## 2. Spawn nested sub-agents for independent sub-tasks
If your task IS decomposable, use the **Agent** tool to spawn nested \`general-purpose\`
sub-agents — one per independent sub-task. Batch all independent spawns in a **single
message** (multiple Agent tool calls in one response) so they run concurrently.

For each nested sub-agent:
  - Set \`inherit_context: false\` (strict context isolation — do NOT inherit this
    conversation; the sub-agent gets only what you put in its prompt).
  - Set \`isolated: false\` (the default) if the sub-task may need to spawn its own
    children — \`isolated: true\` removes extension tools including the Agent tool,
    which would break further nesting. Use \`isolated: true\` ONLY for leaf tasks
    that need no further delegation and benefit from a minimal toolset.
  - Omit the \`model\` parameter to inherit the parent session's model (recommended
    for consistency); specify \`model\` only when a genuinely different model is
    better for the sub-task. \`thinking\` and \`max_turns\` likewise inherit sensibly
    from your session — set them only with reason.
  - Write a **self-contained prompt** containing: the sub-task description, any
    necessary file paths or context, and the **full text of this protocol** (copy it
    verbatim, including the Verification Gate command in section 5, so the sub-agent
    follows the same rules and can spawn its own children).
  - Use \`run_in_background: true\` for independent spawns so they run concurrently.
  - Collect results from all spawned sub-agents before proceeding.

## 3. Sequence dependent sub-tasks
If some sub-tasks depend on the output of others, spawn the independent ones first
(in one batch), wait for their results, then spawn the dependent ones with the
predecessor results included in their prompts.

## 4. If your task is NOT decomposable
If the task is a single focused unit of work (one file, one function), do it directly
with your own tools (edit, write, bash, etc.). Do not spawn a sub-agent for trivial work.

${gateSection}

## 6. Structured result
End your work with this exact block (replace N with your step number and content
with a concise summary of what you changed/accomplished, including key file paths):

=== STEP RESULT (Step N) ===
<concise summary of what changed / was accomplished, incl. key file paths>
=== END STEP RESULT ===
`.trim();
}

/** Backward-compatible re-export for existing code that imports NESTING_PROTOCOL. */
export const NESTING_PROTOCOL = buildNestingProtocol();

// ---------------------------------------------------------------------------
// Scoped prompt builder
// ---------------------------------------------------------------------------

/**
 * Helper to iteratively find all transitive predecessor step IDs (ancestors) in the DAG.
 *
 * Uses an explicit stack instead of recursion to avoid stack overflow on
 * deeply nested DAGs (e.g., 10 000+ steps in a linear chain).
 */
function getTransitiveAncestors(stepId: number, allSteps: PlanStep[]): Set<number> {
	const ancestors = new Set<number>();
	const byId = new Map(allSteps.map((s) => [s.id, s]));

	// Iterative DFS with explicit stack
	const stack = [stepId];
	while (stack.length > 0) {
		const currentId = stack.pop()!;
		const step = byId.get(currentId);
		if (!step) continue;
		for (const depId of step.dependencies) {
			if (!ancestors.has(depId)) {
				ancestors.add(depId);
				stack.push(depId);
			}
		}
	}

	return ancestors;
}

/**
 * Build a focused prompt for a sub-agent executing a single plan step.
 *
 * The prompt contains:
 *   1. A brief overall plan summary (for orientation, not full context).
 *   2. Results from all transitive predecessor steps (ancestors) in dependency order.
 *   3. The Nested Sub-Agent Protocol (self-similar — embedded gate command).
 *   4. The step's own task text + result-contract instructions.
 *
 * This is the core context-isolation mechanism: the sub-agent does NOT receive
 * the full parent conversation, only what's relevant to its specific task.
 */
export function buildStepPrompt(
	step: PlanStep,
	allSteps: PlanStep[],
	predecessorResults: Map<number, string>,
	planSummary: string,
	gateCommand: string | null = null,
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

	// 3. Nested Sub-Agent Protocol (self-similar, with embedded gate command)
	sections.push(`# Nested Sub-Agent Protocol\n\n${buildNestingProtocol(gateCommand)}`);

	// 4. The actual task
	sections.push(
		`# Your Task — Step ${step.id}\n\n${step.text}\n\n` +
		`Execute this step completely. When done, provide a concise summary using the structured result block described in the protocol above (replace N with ${step.id}).` +
		`\nDo NOT work on other steps — only step ${step.id}.`,
	);

	return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Deadlock detection
// ---------------------------------------------------------------------------

/**
 * Detect deadlocked steps — pending steps whose transitive predecessors
 * include a failed step. Such steps can never become ready and would block
 * execution indefinitely.
 *
 * Uses iterative BFS on the ancestor chain to avoid stack overflow on
 * deeply nested DAGs. Returns an array of step IDs that are deadlocked.
 */
export function detectDeadlockedSteps(steps: PlanStep[]): number[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const deadlocked: number[] = [];

	// Collect all failed step IDs
	const failedIds = new Set<number>();
	for (const s of steps) {
		if (s.status === "failed") failedIds.add(s.id);
	}

	if (failedIds.size === 0) return [];

	// For each pending step, trace ancestors iteratively
	for (const step of steps) {
		if (step.status !== "pending") continue;

		const visited = new Set<number>();
		const stack = [...step.dependencies];
		let hasFailedAncestor = false;

		while (stack.length > 0 && !hasFailedAncestor) {
			const depId = stack.pop()!;
			if (visited.has(depId)) continue;
			visited.add(depId);

			if (failedIds.has(depId)) {
				hasFailedAncestor = true;
				break;
			}

			const dep = byId.get(depId);
			if (dep) {
				for (const grandDepId of dep.dependencies) {
					if (!visited.has(grandDepId)) {
						stack.push(grandDepId);
					}
				}
			}
		}

		if (hasFailedAncestor) {
			deadlocked.push(step.id);
		}
	}

	return deadlocked;
}

// ---------------------------------------------------------------------------
// Plan summary extraction
// ---------------------------------------------------------------------------

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
