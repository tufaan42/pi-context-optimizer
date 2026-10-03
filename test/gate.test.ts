import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectInvariantsGate } from "../utils.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = join(process.cwd(), `.tmp-test-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(dir, { recursive: true });
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("detectInvariantsGate - tsconfig.json → npx tsc --noEmit", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "tsconfig.json"), "{}", "utf8");
		const gate = detectInvariantsGate(dir);
		assert.ok(gate);
		assert.ok(gate!.includes("npx tsc --noEmit"));
	});
});

test("detectInvariantsGate - tsconfig + lint script in package.json", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "tsconfig.json"), "{}", "utf8");
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { lint: "eslint ." } }),
			"utf8",
		);
		const gate = detectInvariantsGate(dir);
		assert.ok(gate);
		assert.ok(gate!.includes("npx tsc --noEmit"));
		assert.ok(gate!.includes("eslint ."));
	});
});

test("detectInvariantsGate - go.mod → go vet && go build", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "go.mod"), "module example\n\ngo 1.21\n", "utf8");
		const gate = detectInvariantsGate(dir);
		assert.equal(gate, "go vet ./... && go build ./...");
	});
});

test("detectInvariantsGate - pyproject.toml → ruff check", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "pyproject.toml"), "[project]\nname = 'test'\n", "utf8");
		const gate = detectInvariantsGate(dir);
		assert.ok(gate);
		assert.ok(gate!.includes("ruff check ."));
		// No mypy config → should NOT include mypy
		assert.ok(!gate!.includes("mypy"));
	});
});

test("detectInvariantsGate - pyproject.toml with [tool.mypy] → ruff && mypy", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "pyproject.toml"), "[project]\nname = 'test'\n\n[tool.mypy]\n", "utf8");
		const gate = detectInvariantsGate(dir);
		assert.ok(gate);
		assert.ok(gate!.includes("ruff check ."));
		assert.ok(gate!.includes("mypy ."));
	});
});

test("detectInvariantsGate - empty dir → null", async () => {
	await withTempDir(async (dir) => {
		const gate = detectInvariantsGate(dir);
		assert.equal(gate, null);
	});
});
