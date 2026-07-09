import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlanToDAG, computeCriticalPath, getReadySteps } from "../dag.ts";

test("Cycle detection - self reference", () => {
	const plan = `
# Plan
1. Step A (depends: 1)
`;
	const steps = parsePlanToDAG(plan);
	const cpMap = computeCriticalPath(steps);
	assert.equal(cpMap.get(1), 0);
});

test("Cycle detection - mutual dependency loop", () => {
	// 1 depends on 2, and 2 depends on 1
	const plan = `
# Plan
1. Step A (depends: 2)
2. Step B (depends: 1)
`;
	const steps = parsePlanToDAG(plan);
	const cpMap = computeCriticalPath(steps);
	// Verify it computed finite values and didn't crash
	assert.ok(Number.isFinite(cpMap.get(1)));
	assert.ok(Number.isFinite(cpMap.get(2)));
});
