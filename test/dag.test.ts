import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parsePlanToDAG,
	computeCriticalPath,
	getReadySteps,
	buildStepPrompt,
	extractPlanSummary,
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
