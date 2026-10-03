import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Dispatcher, type SpawnAgentFn } from "../dispatcher.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = join(process.cwd(), `.tmp-test-disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(dir, { recursive: true });
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function makeStubCtx(cwd: string): any {
	return {
		cwd,
		ui: { notify: () => {} },
	};
}

/** Build a stub spawnAgent that records calls and resolves with a synthetic result. */
function makeRecordingSpawn(records: number[]): SpawnAgentFn {
	return async (_ctx, _type, prompt, _opts) => {
		const m = prompt.match(/step (\d+) of/i);
		const stepNum = m ? parseInt(m[1]!, 10) : 0;
		records.push(stepNum);
		return {
			responseText: `=== STEP RESULT (Step ${stepNum}) ===\nDone step ${stepNum}\n=== END STEP RESULT ===`,
			aborted: false,
		};
	};
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("Dispatcher - dependent step not dispatched before prerequisite completes", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
`;
		const records: number[] = [];
		let resolveA: () => void = () => {};
		const pendingA = new Promise<void>((r) => { resolveA = r; });

		const stubSpawn: SpawnAgentFn = async (_ctx, _type, prompt, _opts) => {
			const m = prompt.match(/step (\d+) of/i);
			const stepNum = m ? parseInt(m[1]!, 10) : 0;
			records.push(stepNum);
			if (stepNum === 1) await pendingA;
			return {
				responseText: `=== STEP RESULT (Step ${stepNum}) ===\nDone ${stepNum}\n=== END STEP RESULT ===`,
				aborted: false,
			};
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(100);

		// Only step 1 should have been spawned so far (step 2 depends on it)
		assert.deepEqual(records, [1], "step 2 should not be spawned before step 1 completes");

		// Now resolve step 1
		resolveA();
		await sleep(200);

		// Step 2 should now have been spawned
		assert.ok(records.includes(2), "step 2 should be spawned after step 1 completes");
		assert.ok(records.indexOf(1) < records.indexOf(2), "step 1 must be spawned before step 2");

		dispatcher.stop();
	});
});

test("Dispatcher - no double-spawn (idempotency guard)", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const records: number[] = [];
		let resolveA: () => void = () => {};
		const pendingA = new Promise<void>((r) => { resolveA = r; });

		const stubSpawn: SpawnAgentFn = async (_ctx, _type, prompt, _opts) => {
			const m = prompt.match(/step (\d+) of/i);
			const stepNum = m ? parseInt(m[1]!, 10) : 0;
			records.push(stepNum);
			await pendingA; // hold so status stays in_flight
			return { responseText: `Done ${stepNum}`, aborted: false };
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(100);

		// Fire multiple concurrent dispatchReady calls
		await Promise.all([dispatcher.dispatchReady(), dispatcher.dispatchReady(), dispatcher.dispatchReady()]);
		await sleep(100);

		// Step 1 should only have been spawned ONCE
		assert.equal(records.filter((n) => n === 1).length, 1, "step 1 should not be double-spawned");

		resolveA();
		await sleep(150);
		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - drain loop fans out independent ready steps", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
2. Step B
3. Step C
`;
		const records: number[] = [];
		const stubSpawn = makeRecordingSpawn(records);
		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(300);

		// All 3 independent steps should have been spawned
		assert.equal(records.length, 3, "all independent steps should be dispatched");
		assert.ok(records.includes(1));
		assert.ok(records.includes(2));
		assert.ok(records.includes(3));

		// All should be done
		const status = dispatcher.getStatus();
		assert.equal(status.done, 3);
		assert.equal(status.total, 3);

		dispatcher.stop();
	});
});

test("Dispatcher - spawn receives depth: 1 (off-by-one fix)", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const observedDepths: number[] = [];
		const stubSpawn: SpawnAgentFn = async (_ctx, _type, _prompt, opts) => {
			observedDepths.push(opts.depth);
			return { responseText: `=== STEP RESULT (Step 1) ===\nDone 1\n=== END STEP RESULT ===`, aborted: false };
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(150);

		// The dispatcher stands in for the top-level session (depth 0), so a step
		// sub-agent must be stamped depth 1 — not 0 — so grandchildren land at depth 2.
		assert.deepEqual(observedDepths, [1], "step sub-agent must be spawned at depth 1, not 0");

		const status = dispatcher.getStatus();
		assert.equal(status.done, 1);

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - resume init() demotes done step with missing predecessor", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
3. Step C (depends: 2)
`;
		// Simulate a crash where step 3's result file exists but step 2's doesn't.
		// Step 3 should be demoted to pending because step 2 isn't done.
		const resultsDir = join(dir, "step-results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(join(resultsDir, "step-1.md"), "Result A", "utf8");
		await writeFile(join(resultsDir, "step-3.md"), "Result C", "utf8");
		// NOTE: step-2.md is intentionally MISSING

		// Use a blocking spawnAgent so dispatched steps stay in_flight and
		// don't cascade-complete before we can assert the demoted status.
		// The blocker is released on teardown so the in-flight step's promise
		// settles and the test process can exit (stop() clears the watchdog but
		// cannot cancel an already-launched spawn, leaving a pending promise).
		let releaseBlocker: () => void = () => {};
		const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
		const stubSpawn: SpawnAgentFn = async () => {
			await blocker;
			return { responseText: "never", aborted: false };
		};
		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(150);

		const steps = dispatcher.getSteps();
		const step1 = steps.find((s) => s.id === 1)!;
		const step2 = steps.find((s) => s.id === 2)!;
		const step3 = steps.find((s) => s.id === 3)!;

		// Step 1 was restored from disk (its file exists and has no predecessors)
		assert.equal(step1.status, "done");

		// Step 2 was not on disk → dispatched (in_flight, blocked)
		assert.equal(step2.status, "in_flight");

		// Step 3 was on disk BUT step 2 is not done → demoted to pending
		assert.equal(step3.status, "pending", "step 3 should be demoted because step 2 is not done");

		// Release the blocker so the in-flight step's promise settles and the
		// test process can exit cleanly.
		releaseBlocker();
		await sleep(100);
		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - failure propagates to all downstream steps", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
3. Step C (depends: 2)
`;
		const stubSpawn: SpawnAgentFn = async (_ctx, _type, prompt, _opts) => {
			const m = prompt.match(/step (\d+) of/i);
			const stepNum = m ? parseInt(m[1]!, 10) : 0;
			if (stepNum === 1) {
				throw new Error("Simulated failure in step 1");
			}
			return {
				responseText: `=== STEP RESULT (Step ${stepNum}) ===\nDone ${stepNum}\n=== END STEP RESULT ===`,
				aborted: false,
			};
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, 5000, stubSpawn);
		// Disable retries so step 1 fails immediately without T-SEDR 3-strike delay
		dispatcher.getSteps()[0]!.config = { timeoutMs: 5000, maxRetries: 0, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(300);

		const status = dispatcher.getStatus();
		assert.equal(status.total, 3);
		assert.equal(status.failed, 3, "all steps should fail because step 1 failed");
		assert.equal(status.done, 0, "no steps should be done");

		const steps = dispatcher.getSteps();
		const step1 = steps.find((s) => s.id === 1)!;
		const step2 = steps.find((s) => s.id === 2)!;
		const step3 = steps.find((s) => s.id === 3)!;

		assert.equal(step1.status, "failed");
		assert.ok(step1.error?.includes("Simulated failure"), "step 1 should have its own error");

		assert.equal(step2.status, "failed");
		assert.ok(step2.error?.includes("Prerequisite step 1 failed"), "step 2 should mention step 1 failure");

		assert.equal(step3.status, "failed");
		assert.ok(step3.error?.includes("Prerequisite step 2 failed") || step3.error?.includes("Prerequisite step 1 failed"),
			"step 3 should mention prerequisite failure");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - independent steps unaffected by failure in separate branch", async () => {
	await withTempDir(async (dir) => {
		// Explicit (depends: ) prevents the linear-chain fallback in parsePlanToDAG
		const plan = `
# Plan
1. Step A (depends: )
2. Step B (depends: )
`;
		const stubSpawn: SpawnAgentFn = async (_ctx, _type, prompt, _opts) => {
			const m = prompt.match(/step (\d+) of/i);
			const stepNum = m ? parseInt(m[1]!, 10) : 0;
			if (stepNum === 1) {
				throw new Error("Step 1 failure");
			}
			return {
				responseText: `=== STEP RESULT (Step ${stepNum}) ===\nDone ${stepNum}\n=== END STEP RESULT ===`,
				aborted: false,
			};
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, 5000, stubSpawn);
		// Disable retries on step 1 so it fails immediately; step 2 (index 1) keeps defaults
		dispatcher.getSteps()[0]!.config = { timeoutMs: 5000, maxRetries: 0, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(300);

		const status = dispatcher.getStatus();
		assert.equal(status.total, 2);
		assert.equal(status.failed, 1, "only step 1 should fail");
		assert.equal(status.done, 1, "step 2 should complete independently");

		const steps = dispatcher.getSteps();
		assert.equal(steps.find((s) => s.id === 1)!.status, "failed");
		assert.equal(steps.find((s) => s.id === 2)!.status, "done");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - propagated failure includes original error message in chain", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
2. Step B (depends: 1)
`;
		const stubSpawn: SpawnAgentFn = async (_ctx, _type, prompt, _opts) => {
			const m = prompt.match(/step (\d+) of/i);
			const stepNum = m ? parseInt(m[1]!, 10) : 0;
			if (stepNum === 1) {
				throw new Error("Custom error: database unreachable");
			}
			return {
				responseText: `=== STEP RESULT (Step ${stepNum}) ===\nDone ${stepNum}\n=== END STEP RESULT ===`,
				aborted: false,
			};
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, 5000, stubSpawn);
		// Disable retries so step 1 fails immediately without T-SEDR 3-strike delay
		dispatcher.getSteps()[0]!.config = { timeoutMs: 5000, maxRetries: 0, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(300);

		const steps = dispatcher.getSteps();
		const step2 = steps.find((s) => s.id === 2)!;

		// The propagated error should reference the original error message
		assert.ok(step2.error?.includes("Custom error: database unreachable"),
			"propagated error should include original error message");
		assert.ok(step2.error?.includes("Prerequisite step 1 failed"),
			"propagated error should indicate prerequisite failure");

		dispatcher.stop();
		await sleep(50);
	});
});

// =========================================================================
// Dispatcher hardening tests (Steps 5–10)
// =========================================================================

test("Dispatcher - step timeout fires correctly", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		// Spawn agent that never resolves — timeout must be the only way out.
		// We keep a reject handle so the orphaned spawn promise can be settled on
		// teardown; otherwise node:test waits forever on the never-settling
		// promise (the dispatcher's Promise.race already rejected on timeout, but
		// the losing spawn promise is still pending).
		let rejectSpawn: (e: Error) => void = () => {};
		const stubSpawn: SpawnAgentFn = async () => {
			return new Promise<never>((_resolve, reject) => { rejectSpawn = reject; });
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		// No retries + very short timeout so the step fails immediately on timeout
		dispatcher.getSteps()[0]!.config = { timeoutMs: 50, maxRetries: 0, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(300);

		const status = dispatcher.getStatus();
		const steps = dispatcher.getSteps();

		assert.equal(status.failed, 1, "step should fail due to timeout");
		assert.equal(steps[0]!.status, "failed");
		assert.ok(steps[0]!.error?.includes("timed out"), "error should mention timeout: " + steps[0]!.error);

		// Settle the orphaned spawn promise so the process can exit.
		rejectSpawn(new Error("test teardown"));
		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - retry on transient failure", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		let callCount = 0;
		const stubSpawn: SpawnAgentFn = async (_ctx, _type, _prompt, _opts) => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Transient failure");
			}
			return {
				responseText: `=== STEP RESULT (Step 1) ===\nDone 1\n=== END STEP RESULT ===`,
				aborted: false,
			};
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		// One retry allowed with short backoff
		dispatcher.getSteps()[0]!.config = { timeoutMs: 5000, maxRetries: 1, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(500);

		const status = dispatcher.getStatus();
		const steps = dispatcher.getSteps();

		assert.equal(status.done, 1, "step should succeed after retry");
		assert.equal(steps[0]!.status, "done");
		assert.equal(callCount, 2, "spawn should be called twice (first attempt + retry)");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - retry exhaust marks step as failed", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		let callCount = 0;
		const stubSpawn: SpawnAgentFn = async () => {
			callCount++;
			throw new Error("Persistent failure");
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		// 2 retries = 3 total attempts, short backoff
		dispatcher.getSteps()[0]!.config = { timeoutMs: 500, maxRetries: 2, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(500);

		const status = dispatcher.getStatus();
		const steps = dispatcher.getSteps();

		assert.equal(status.failed, 1, "step should fail after all retries exhausted");
		assert.equal(steps[0]!.status, "failed");
		assert.equal(callCount, 3, "spawn should be called 3 times (1 initial + 2 retries)");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - onAllDone called when all steps complete", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
2. Step B
`;
		const records: number[] = [];
		const stubSpawn = makeRecordingSpawn(records);

		let allDoneStatus: any = null;
		const onAllDone = (status: any) => {
			allDoneStatus = status;
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn, undefined, onAllDone);
		await dispatcher.init();
		await sleep(300);

		assert.ok(allDoneStatus !== null, "onAllDone should have been called");
		assert.equal(allDoneStatus.done, 2);
		assert.equal(allDoneStatus.total, 2);
		assert.equal(allDoneStatus.failed, 0);

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - onAllDone called on total failure", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const stubSpawn: SpawnAgentFn = async () => {
			throw new Error("Always fails");
		};

		let allDoneStatus: any = null;
		const onAllDone = (status: any) => {
			allDoneStatus = status;
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn, undefined, onAllDone);
		// Set low retry delay and minimal retries so test finishes fast
		dispatcher.getSteps()[0]!.config = { timeoutMs: 500, maxRetries: 0, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(300);

		assert.ok(allDoneStatus !== null, "onAllDone should have been called on total failure");
		assert.equal(allDoneStatus.done, 0);
		assert.equal(allDoneStatus.failed, 1);
		assert.equal(allDoneStatus.total, 1);

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - model propagated to spawn options", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const capturedOpts: any[] = [];
		const stubSpawn: SpawnAgentFn = async (_ctx, _type, _prompt, opts) => {
			capturedOpts.push({ ...opts });
			return {
				responseText: `=== STEP RESULT (Step 1) ===\nDone 1\n=== END STEP RESULT ===`,
				aborted: false,
			};
		};

		const modelStub = { id: "anthropic/claude-sonnet-4-20250514" };
		const ctx = {
			cwd: dir,
			ui: { notify: () => {} },
			model: modelStub,
		};

		const dispatcher = new Dispatcher({} as any, ctx as any, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(200);

		const opts = capturedOpts[0];
		assert.ok(opts, "spawnAgent should have been called");
		assert.equal(opts.model, modelStub, "model in spawn options should match ctx.model");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - getMetrics returns step metrics with spawn count and timing", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const stubSpawn = makeRecordingSpawn([]);
		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		await dispatcher.init();
		await sleep(200);

		const metrics = dispatcher.getMetrics();
		assert.ok(metrics.length >= 1, "metrics should contain at least one entry");

		const stepMetrics = metrics.find((m) => m.stepId === 1);
		assert.ok(stepMetrics, "step 1 metrics should exist");
		assert.equal(stepMetrics!.spawnCount, 1, "spawnCount should be 1 (no retries)");
		assert.ok(stepMetrics!.startedAt !== null, "startedAt should be set for completed step");
		assert.ok(stepMetrics!.completedAt !== null, "completedAt should be set for completed step");
		assert.ok(stepMetrics!.durationMs !== null, "durationMs should be set for completed step");
		assert.ok(stepMetrics!.durationMs! >= 0, "durationMs should be non-negative");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - events emitted for lifecycle events", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const events: string[] = [];
		const onEvent = (event: any) => {
			events.push(event.type);
		};

		const stubSpawn = makeRecordingSpawn([]);
		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn, onEvent);
		await dispatcher.init();
		await sleep(200);

		// Should see at minimum: step_started, step_completed, dispatcher_stopped
		assert.ok(events.includes("step_started"), "step_started event should fire");
		assert.ok(events.includes("step_completed"), "step_completed event should fire");
		assert.ok(events.includes("dispatcher_stopped"), "dispatcher_stopped event should fire");

		dispatcher.stop();
		await sleep(50);
	});
});

test("Dispatcher - step metrics capture error on failure", async () => {
	await withTempDir(async (dir) => {
		const plan = `
# Plan
1. Step A
`;
		const stubSpawn: SpawnAgentFn = async () => {
			throw new Error("Test error message");
		};

		const ctx = makeStubCtx(dir);
		const dispatcher = new Dispatcher({} as any, ctx, plan, dir, 10, undefined, stubSpawn);
		// No retries so the failure is immediate
		dispatcher.getSteps()[0]!.config = { timeoutMs: 500, maxRetries: 0, retryDelayMs: 10 };
		await dispatcher.init();
		await sleep(300);

		const metrics = dispatcher.getMetrics();
		const stepMetrics = metrics.find((m) => m.stepId === 1);

		assert.ok(stepMetrics, "step 1 metrics should exist");
		assert.ok(stepMetrics!.lastError?.includes("Test error message"),
			"lastError should contain the error message: " + stepMetrics!.lastError);
		assert.ok(stepMetrics!.completedAt !== null, "completedAt should be set on failure");
		assert.ok(stepMetrics!.durationMs !== null, "durationMs should be set on failure");
		assert.equal(stepMetrics!.spawnCount, 1, "spawnCount should be 1 (no retries)");

		dispatcher.stop();
		await sleep(50);
	});
});
