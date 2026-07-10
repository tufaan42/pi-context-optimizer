// Bridge + fail-open tests for the host-agnostic filesystem protocol.
//
// Covers:
//   - getBridgeConfig() generic-over-legacy-over-null + custom auth header
//   - openArtifactInVSCode() is strictly best-effort (never throws/rejects when
//     no bridge is configured and the `code` binary is unavailable)
//   - writeActivePointer / readActivePointer round-trip + null on malformed
//   - readStatus() status.json schema stability
//
// Run: node --test --experimental-strip-types test/bridge.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBridgeConfig, openArtifactInVSCode, BRIDGE_ENV_KEYS } from "../open.ts";
import { writeActivePointer, readActivePointer, activeFilePath } from "../bridge.ts";
import { readStatus } from "../approval.ts";
import { STATUS_FILE } from "../utils.ts";

/** Run `fn` with all bridge env vars cleared, restoring them after. */
async function withCleanBridgeEnv<T>(fn: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const k of BRIDGE_ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	return fn().finally(() => {
		for (const k of BRIDGE_ENV_KEYS) {
			if (saved[k] !== undefined) process.env[k] = saved[k];
			else delete process.env[k];
		}
	});
}

function tmpRoot(label: string): string {
	return `/tmp/ag-bridge-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// getBridgeConfig
// ---------------------------------------------------------------------------

test("getBridgeConfig returns null when no bridge is configured", async () => {
	await withCleanBridgeEnv(async () => {
		assert.equal(getBridgeConfig(), null);
	});
});

test("getBridgeConfig prefers generic PI_CO_BRIDGE_* over legacy PI_VSCODE_BRIDGE_*", async () => {
	await withCleanBridgeEnv(async () => {
		process.env.PI_CO_BRIDGE_URL = "http://generic";
		process.env.PI_CO_BRIDGE_TOKEN = "gtok";
		process.env.PI_VSCODE_BRIDGE_URL = "http://legacy";
		process.env.PI_VSCODE_BRIDGE_TOKEN = "ltok";
		const cfg = getBridgeConfig();
		assert.equal(cfg?.url, "http://generic");
		assert.equal(cfg?.token, "gtok");
		assert.equal(cfg?.authHeader, "x-pi-bridge-authorization");
	});
});

test("getBridgeConfig falls back to legacy PI_VSCODE_BRIDGE_* with the pi-vscode auth header", async () => {
	await withCleanBridgeEnv(async () => {
		process.env.PI_VSCODE_BRIDGE_URL = "http://legacy";
		process.env.PI_VSCODE_BRIDGE_TOKEN = "ltok";
		const cfg = getBridgeConfig();
		assert.equal(cfg?.url, "http://legacy");
		assert.equal(cfg?.token, "ltok");
		assert.equal(cfg?.authHeader, "x-pi-vscode-authorization");
	});
});

test("getBridgeConfig honors PI_CO_BRIDGE_AUTH_HEADER override", async () => {
	await withCleanBridgeEnv(async () => {
		process.env.PI_CO_BRIDGE_URL = "http://generic";
		process.env.PI_CO_BRIDGE_TOKEN = "gtok";
		process.env.PI_CO_BRIDGE_AUTH_HEADER = "x-custom-auth";
		const cfg = getBridgeConfig();
		assert.equal(cfg?.authHeader, "x-custom-auth");
	});
});

// ---------------------------------------------------------------------------
// openArtifactInVSCode — fail-open guarantee (the core "can't fail for PiLot" property)
// ---------------------------------------------------------------------------

test("openArtifactInVSCode resolves to 'skipped' and never throws when no bridge and exec fails", async () => {
	await withCleanBridgeEnv(async () => {
		// A fake host object whose exec always rejects — simulates a host with
		// no HTTP bridge AND no `code` binary on PATH.
		const fakePi = { exec: async () => { throw new Error("no code binary"); } } as unknown as ExtensionAPI;
		const result = await openArtifactInVSCode(fakePi, "/tmp/does-not-matter.md", true);
		assert.equal(result, "skipped");
	});
});

test("openArtifactInVSCode returns 'opened' when the `code` CLI spawn succeeds (no bridge)", async () => {
	await withCleanBridgeEnv(async () => {
		let spawned: string[] | null = null;
		const fakePi = {
			exec: async (_bin: string, args: string[]) => { spawned = args; },
		} as unknown as ExtensionAPI;
		const result = await openArtifactInVSCode(fakePi, "/tmp/some-plan.md", false);
		assert.equal(result, "opened");
		assert.deepEqual(spawned, ["/tmp/some-plan.md"]);
	});
});

// ---------------------------------------------------------------------------
// active.json pointer
// ---------------------------------------------------------------------------

test("writeActivePointer + readActivePointer round-trip the documented schema", async () => {
	const cwd = tmpRoot("rt");
	try {
		await writeActivePointer(cwd, {
			artifactDir: `${cwd}/.pi/context-optimizer/sess`,
			phase: "REVIEW_PENDING",
			approval: "pending",
			done: 2,
			total: 5,
		});
		const read = await readActivePointer(activeFilePath(cwd));
		assert.equal(read?.artifactDir, `${cwd}/.pi/context-optimizer/sess`);
		assert.equal(read?.phase, "REVIEW_PENDING");
		assert.equal(read?.approval, "pending");
		assert.equal(read?.done, 2);
		assert.equal(read?.total, 5);
		assert.ok(typeof read?.updatedAt === "string" && read.updatedAt.length > 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("readActivePointer returns null for missing, malformed, or incomplete JSON", async () => {
	const cwd = tmpRoot("mal");
	const path = activeFilePath(cwd);
	try {
		// missing file
		assert.equal(await readActivePointer(path), null);
		// malformed JSON
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "{not valid json", "utf8");
		assert.equal(await readActivePointer(path), null);
		// incomplete schema (missing required fields)
		await writeFile(path, JSON.stringify({ phase: "X" }), "utf8");
		assert.equal(await readActivePointer(path), null);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// status.json schema stability (host approve/reject write contract)
// ---------------------------------------------------------------------------

test("readStatus round-trips the documented status.json schema", async () => {
	const dir = tmpRoot("status");
	const path = join(dir, STATUS_FILE);
	try {
		await mkdir(dir, { recursive: true });
		const doc = { phase: "EXECUTING", approval: "approved", done: 3, total: 4, updatedAt: new Date().toISOString() };
		await writeFile(path, JSON.stringify(doc) + "\n", "utf8");
		const s = await readStatus(path);
		assert.equal(s?.phase, "EXECUTING");
		assert.equal(s?.approval, "approved");
		assert.equal(s?.done, 3);
		assert.equal(s?.total, 4);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
