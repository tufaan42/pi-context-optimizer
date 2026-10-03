import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parsePlanToDAG,
	computeCriticalPath,
	getReadySteps,
	buildStepPrompt,
	buildNestingProtocol,
	NESTING_PROTOCOL,
	extractPlanSummary,
	extractStepResult,
} from "../dag.ts";

test("parsePlanToDAG - linear fallback", () => {
	const plan = `
# Plan
1. Step A
2. Step B
3. Step C
`;
	const steps = parsePlanToDAG(plan);
	assert.equal(steps.length, 3);
	assert.deepEqual(steps[0]?.dependencies, []);
	assert.deepEqual(steps[1]?.dependencies, [1]);
	assert.deepEqual(steps[2]?.dependencies, [2]);
});

test("parsePlanToDAG - explicit dependencies", () => {
	const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
3. Step C (depends: 1, 2)
`;
	const steps = parsePlanToDAG(plan);
	assert.equal(steps.length, 3);
	assert.deepEqual(steps[0]?.dependencies, []);
	assert.deepEqual(steps[1]?.dependencies, [1]);
	assert.deepEqual(steps[2]?.dependencies, [1, 2]);
});

test("computeCriticalPath - simple CP priority", () => {
	const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
3. Step C (depends: 1)
4. Step D (depends: 2, 3)
`;
	const steps = parsePlanToDAG(plan);
	const cpMap = computeCriticalPath(steps);
	
	// A -> B -> D
	// A -> C -> D
	// Path lengths: D=0, B=1, C=1, A=2
	assert.equal(cpMap.get(4), 0);
	assert.equal(cpMap.get(2), 1);
	assert.equal(cpMap.get(3), 1);
	assert.equal(cpMap.get(1), 2);
});

test("getReadySteps - simple resolution", () => {
	const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
3. Step C (depends: 1)
`;
	const steps = parsePlanToDAG(plan);
	const cpMap = computeCriticalPath(steps);

	// Initially only Step 1 is ready
	let ready = getReadySteps(steps, cpMap);
	assert.equal(ready.length, 1);
	assert.equal(ready[0]?.id, 1);

	// Mark step 1 done
	steps[0]!.status = "done";
	ready = getReadySteps(steps, cpMap);
	assert.equal(ready.length, 2);
	assert.equal(ready[0]?.id, 2);
	assert.equal(ready[1]?.id, 3);
});

test("extractPlanSummary", () => {
	const plan = `
# Test Plan
This is the plan description.
It should be extracted.

## Tasks
1. Task 1
`;
	const summary = extractPlanSummary(plan);
	assert.ok(summary.includes("Test Plan"));
	assert.ok(summary.includes("description"));
	assert.ok(!summary.includes("Task 1"));
});

test("buildStepPrompt - transitive context propagation", () => {
	const plan = `
# Test Plan
1. Step A
2. Step B (depends: 1)
3. Step C (depends: 2)
`;
	const steps = parsePlanToDAG(plan);
	const results = new Map<number, string>([
		[1, "Result A content"],
		[2, "Result B content"]
	]);

	const step3 = steps.find(s => s.id === 3)!;
	const prompt = buildStepPrompt(step3, steps, results, "Plan summary");

	// Step 3 depends directly on Step 2, and transitively on Step 1.
	// Both must be included in the prompt in chronological order.
	assert.ok(prompt.includes("Step 1"));
	assert.ok(prompt.includes("Result A content"));
	assert.ok(prompt.includes("Transitive Prerequisite"));
	
	assert.ok(prompt.includes("Step 2"));
	assert.ok(prompt.includes("Result B content"));
	assert.ok(prompt.includes("Direct Prerequisite"));

	// Step 1 should appear before Step 2 in the text
	const index1 = prompt.indexOf("Step 1");
	const index2 = prompt.indexOf("Step 2");
	assert.ok(index1 < index2);
});

test("parsePlanToDAG - heading format (### Step N — text)", () => {
	const plan = `
# Plan

### Step 1 — Set up the database (depends: )
### Step 2 — Build the API (depends: 1)
### Step 3 — Wire the UI (depends: 1, 2)
`;
	const steps = parsePlanToDAG(plan);
	assert.equal(steps.length, 3);
	assert.equal(steps[0]?.id, 1);
	assert.equal(steps[1]?.id, 2);
	assert.equal(steps[2]?.id, 3);
	assert.deepEqual(steps[0]?.dependencies, []);
	assert.deepEqual(steps[1]?.dependencies, [1]);
	assert.deepEqual(steps[2]?.dependencies, [1, 2]);
});

test("parsePlanToDAG - duplicate step IDs are skipped", () => {
	const plan = `
# Plan
1. First step
2. Second step
1. Duplicate step (should be skipped)
3. Third step (depends: 1, 2)
`;
	const steps = parsePlanToDAG(plan);
	assert.equal(steps.length, 3);
	assert.equal(steps[0]?.text, "First step");
	assert.equal(steps[2]?.text, "Third step");
});

test("extractStepResult - extracts structured block", () => {
	const raw = `Some preamble text...
=== STEP RESULT (Step 3) ===
Fixed the authentication module in src/auth.ts.
Added token refresh logic.
=== END STEP RESULT ===
Some trailing text...`;
	const result = extractStepResult(raw);
	assert.ok(result.includes("Fixed the authentication module"));
	assert.ok(result.includes("Added token refresh logic"));
	assert.ok(!result.includes("preamble"));
	assert.ok(!result.includes("trailing"));
});

test("extractStepResult - falls back to full text when block absent", () => {
	const raw = "Just some plain output without the structured block.";
	const result = extractStepResult(raw);
	assert.equal(result, raw);
});

test("buildStepPrompt - includes nesting protocol and verification gate", () => {
	const plan = `
# Test Plan
1. Step A
2. Step B (depends: 1)
`;
	const steps = parsePlanToDAG(plan);
	const results = new Map<number, string>([
		[1, "Result A content"],
	]);

	const step2 = steps.find(s => s.id === 2)!;
	const prompt = buildStepPrompt(step2, steps, results, "Plan summary", "npx tsc --noEmit");

	// Nesting Protocol section present
	assert.ok(prompt.includes("Nested Sub-Agent Protocol"), "prompt should include the nesting protocol section");
	assert.ok(prompt.includes("Agent"), "protocol should mention the Agent tool");
	assert.ok(prompt.includes("inherit_context: false"), "protocol should mention context isolation");
	assert.ok(prompt.includes("verbatim"), "protocol should mention verbatim propagation");

	// Verification Gate section present with the concrete command
	assert.ok(prompt.includes("Verification Gate"), "prompt should include the verification gate section");
	assert.ok(prompt.includes("npx tsc --noEmit"), "gate should include the detected command");

	// Result contract instructions present
	assert.ok(prompt.includes("STEP RESULT"), "prompt should include the result contract");
	assert.ok(prompt.includes("END STEP RESULT"), "prompt should include the result close marker");
});

test("buildStepPrompt - gate section says none detected when null", () => {
	const plan = `
# Test Plan
1. Step A
`;
	const steps = parsePlanToDAG(plan);
	const step1 = steps.find(s => s.id === 1)!;
	const prompt = buildStepPrompt(step1, steps, new Map(), "summary", null);
	assert.ok(prompt.includes("No automated gate command was detected"), "should say no gate detected");
});

test("buildNestingProtocol - includes all 6 sections", () => {
	const protocol = buildNestingProtocol("npx tsc --noEmit");

	// All 6 sections must be present
	assert.ok(protocol.includes("## 1. Assess decomposability"));
	assert.ok(protocol.includes("## 2. Spawn nested sub-agents for independent sub-tasks"));
	assert.ok(protocol.includes("## 3. Sequence dependent sub-tasks"));
	assert.ok(protocol.includes("## 4. If your task is NOT decomposable"));
	assert.ok(protocol.includes("## 5. Verification Gate"));
	assert.ok(protocol.includes("## 6. Structured result"));

	// The gate command must appear in section 5
	assert.ok(protocol.includes("npx tsc --noEmit"));

	// Result contract markers
	assert.ok(protocol.includes("STEP RESULT"));
	assert.ok(protocol.includes("END STEP RESULT"));
});

test("buildNestingProtocol - gate command embedded verbatim in bash block", () => {
	const cmd = "go vet ./... && go build ./...";
	const protocol = buildNestingProtocol(cmd);

	// The command must appear inside a bash code fence
	assert.ok(protocol.includes("```bash"));
	assert.ok(protocol.includes(cmd));
	assert.ok(protocol.includes("```"));

	// No "none detected" fallback
	assert.ok(!protocol.includes("No automated gate command was detected"));
});

test("buildNestingProtocol - null gate shows none detected fallback", () => {
	const protocol = buildNestingProtocol(null);

	// Must say "none detected" instead of a command
	assert.ok(protocol.includes("No automated gate command was detected"));

	// Should NOT contain a bash code block for the gate
	assert.ok(!protocol.includes("```bash"));

	// Other sections still present
	assert.ok(protocol.includes("## 1. Assess decomposability"));
	assert.ok(protocol.includes("## 6. Structured result"));
});

test("buildNestingProtocol - backward-compatible NESTING_PROTOCOL const", () => {
	// The const is buildNestingProtocol() with no args (null gate)
	assert.ok(typeof NESTING_PROTOCOL === "string");
	assert.ok(NESTING_PROTOCOL.length > 100);
	assert.ok(NESTING_PROTOCOL.includes("No automated gate command was detected"));
	assert.ok(NESTING_PROTOCOL.includes("## 1. Assess decomposability"));
	assert.ok(NESTING_PROTOCOL.includes("## 6. Structured result"));
});

test("buildNestingProtocol - protocol mentions verbatim propagation to children", () => {
	const protocol = buildNestingProtocol("npx tsc --noEmit");

	// The protocol must instruct sub-agents to copy it verbatim so grandchildren
	// receive the same rules and gate command.
	assert.ok(protocol.includes("verbatim"), "protocol should instruct verbatim copying");
	assert.ok(protocol.includes("self-contained"), "protocol should mention self-contained prompts");
	assert.ok(protocol.includes("inherit_context: false"), "protocol should mention context isolation");
	assert.ok(protocol.includes("run_in_background: true"), "protocol should mention background spawns");
});

test("buildStepPrompt - diamond DAG transitive ancestor propagation", () => {
	const plan = `
# Test Plan
1. Step A — root step
2. Step B (depends: 1) — B depends on A
3. Step C (depends: 1) — C depends on A
4. Step D (depends: 2, 3) — D depends on both B and C
`;
	const steps = parsePlanToDAG(plan);
	const results = new Map<number, string>([
		[1, "Result A"],
		[2, "Result B"],
		[3, "Result C"],
	]);

	const step4 = steps.find(s => s.id === 4)!;
	const prompt = buildStepPrompt(step4, steps, results, "Plan summary");

	// All transitive ancestors should appear
	assert.ok(prompt.includes("Step 1"), "should include Step 1");
	assert.ok(prompt.includes("Step 2"), "should include Step 2");
	assert.ok(prompt.includes("Step 3"), "should include Step 3");
	assert.ok(prompt.includes("Result A"), "should include Step 1 result");
	assert.ok(prompt.includes("Result B"), "should include Step 2 result");
	assert.ok(prompt.includes("Result C"), "should include Step 3 result");

	// Steps 2 and 3 are direct prerequisites of step 4
	const directMatches = prompt.match(/Direct Prerequisite/g);
	assert.ok(directMatches, "should have Direct Prerequisite labels");
	assert.equal(directMatches!.length, 2, "steps 2 and 3 should both be Direct Prerequisites");

	// Step 1 is a transitive prerequisite of step 4 (depends on 2 and 3, which depend on 1)
	assert.ok(prompt.includes("Transitive Prerequisite"), "Step 1 should be labeled Transitive Prerequisite");

	// Ancestors in chronological order
	const idx1 = prompt.indexOf("Step 1");
	const idx2 = prompt.indexOf("Step 2");
	const idx3 = prompt.indexOf("Step 3");
	assert.ok(idx1 < idx2, "Step 1 should appear before Step 2");
	assert.ok(idx2 < idx3, "Step 2 should appear before Step 3");
});

test("buildStepPrompt - excludes unrelated steps from ancestor chain", () => {
	const plan = `
# Plan
1. Step A — independent
2. Step B — independent
3. Step C (depends: 2) — depends only on B
`;
	const steps = parsePlanToDAG(plan);
	const results = new Map<number, string>([
		[1, "Result A"],
		[2, "Result B"],
	]);

	const step3 = steps.find(s => s.id === 3)!;
	const prompt = buildStepPrompt(step3, steps, results, "Plan summary");

	// Step 3 depends on Step 2, so Step 2 should be present
	assert.ok(prompt.includes("Step 2"), "should include direct prerequisite Step 2");
	assert.ok(prompt.includes("Result B"), "should include Step 2 result");

	// Step 1 is NOT an ancestor of Step 3, so its result should NOT appear
	assert.ok(!prompt.includes("Result A"), "unrelated step 1 result should not appear");
});

test("buildStepPrompt - single step with no ancestors includes just plan and task", () => {
	const plan = `
# Plan
1. Solo step
`;
	const steps = parsePlanToDAG(plan);
	const step1 = steps.find(s => s.id === 1)!;
	const prompt = buildStepPrompt(step1, steps, new Map(), "Plan summary", null);

	// Should NOT have a Prerequisite section
	assert.ok(!prompt.includes("Prerequisite Step Results"), "no ancestors, no prerequisite section");

	// Should have plan context, protocol, and task
	assert.ok(prompt.includes("Plan Context"));
	assert.ok(prompt.includes("Nested Sub-Agent Protocol"));
	assert.ok(prompt.includes("Solo step"));
});

test("buildStepPrompt - result contract uses correct step number", () => {
	const plan = `
# Test Plan
1. Step A
2. Step B (depends: 1)
`;
	const steps = parsePlanToDAG(plan);
	const results = new Map<number, string>([[1, "Result A"]]);
	const step2 = steps.find(s => s.id === 2)!;
	const prompt = buildStepPrompt(step2, steps, results, "Summary");

	// The result contract should reference Step 2, not a hardcoded number
	assert.ok(prompt.includes("Step 2"), "should reference step 2");
	assert.ok(prompt.includes("replace N with 2"), "instruction should say replace N with 2");
	assert.ok(prompt.includes("only step 2"), "should say only step 2");
});

test("buildNestingProtocol - embeds gate command inside the protocol for self-similar propagation", () => {
	const protocol = buildNestingProtocol("npx tsc --noEmit");
	// The gate command should appear inside the protocol
	assert.ok(protocol.includes("npx tsc --noEmit"), "gate command should appear in the protocol");
	// Section 5 heading with capital G
	assert.ok(protocol.includes("## 5. Verification Gate"), "should have section 5 heading");
	// The gate command should be AFTER the section heading
	const headingIdx = protocol.indexOf("## 5. Verification Gate");
	const cmdIdx = protocol.indexOf("npx tsc --noEmit");
	assert.ok(headingIdx < cmdIdx, "section heading should precede gate command");
});

test("buildNestingProtocol - null gate produces the no-detected message", () => {
	const protocol = buildNestingProtocol(null);
	assert.ok(protocol.includes("No automated gate command was detected"), "null gate should produce fallback message");
	assert.ok(!protocol.includes("npx tsc"), "null gate should not embed a command");
});

test("buildNestingProtocol - includes isolated and model guidance", () => {
	const protocol = buildNestingProtocol();
	// Should mention isolated: false guidance
	assert.ok(protocol.includes("isolated: false"), "should mention isolated: false");
	// Should mention inheriting parent session's model
	assert.ok(protocol.includes("inherit the parent session's model") || protocol.includes("Omit the model"), "should mention model inheritance guidance");
});

test("buildStepPrompt - gate command appears inside protocol section, not separately", () => {
	const plan = `
# Test Plan
1. Step A
2. Step B (depends: 1)
`;
	const steps = parsePlanToDAG(plan);
	const results = new Map<number, string>([
		[1, "Result A content"],
	]);
	const step2 = steps.find(s => s.id === 2)!;
	const prompt = buildStepPrompt(step2, steps, results, "Plan summary", "npx tsc --noEmit");

	// The gate command must be inside the Nested Sub-Agent Protocol section
	const protocolHeading = prompt.indexOf("# Nested Sub-Agent Protocol");
	const taskHeading = prompt.indexOf("# Your Task");
	assert.ok(protocolHeading >= 0, "should have Nested Sub-Agent Protocol section");
	assert.ok(taskHeading >= 0, "should have Your Task section");

	// The gate command should be between protocol heading and task heading
	const cmdIdx = prompt.indexOf("npx tsc --noEmit");
	assert.ok(cmdIdx > protocolHeading, "gate command should be after protocol heading");
	assert.ok(cmdIdx < taskHeading, "gate command should be before Your Task heading");
});

test("parsePlanToDAG - parses agent annotations correctly", () => {
	const plan = `
# Plan
1. Step 1 (agent: scout): Explore the repository layout
2. Step 2 (agent: worker, depends: 1): Implement the feature
3. Step 3 (agent: reviewer, depends: 2): Review the implementation and test
4. Step 4 (depends: 3): Final verification
`;
	const steps = parsePlanToDAG(plan);
	assert.equal(steps.length, 4);
	assert.equal(steps[0]?.agent, "scout");
	assert.equal(steps[1]?.agent, "worker");
	assert.equal(steps[2]?.agent, "reviewer");
	assert.equal(steps[3]?.agent, undefined);
	assert.deepEqual(steps[1]?.dependencies, [1]);
	assert.deepEqual(steps[2]?.dependencies, [2]);
	assert.ok(!steps[0]?.text.includes("agent:"));
	assert.ok(!steps[1]?.text.includes("agent:"));
});

