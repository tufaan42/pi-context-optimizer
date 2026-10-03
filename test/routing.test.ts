import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedPath, isDestructiveBash, classifyTaskRisk } from "../utils.ts";

test("isProtectedPath identifies sensitive project files", () => {
	assert.equal(isProtectedPath("package.json"), true);
	assert.equal(isProtectedPath("/Users/user/project/package.json"), true);
	assert.equal(isProtectedPath("pnpm-lock.yaml"), true);
	assert.equal(isProtectedPath("Cargo.lock"), true);
	assert.equal(isProtectedPath("go.mod"), true);
	assert.equal(isProtectedPath("tsconfig.json"), true);
	assert.equal(isProtectedPath("tsconfig.node.json"), true);
	assert.equal(isProtectedPath("vite.config.ts"), true);
	assert.equal(isProtectedPath("next.config.mjs"), true);
	assert.equal(isProtectedPath(".github/workflows/deploy.yml"), true);
	assert.equal(isProtectedPath("/repo/.github/workflows/test.yml"), true);
	assert.equal(isProtectedPath("src/migrations/001_init.sql"), true);
	assert.equal(isProtectedPath(".env"), true);
	assert.equal(isProtectedPath(".env.production"), true);
	assert.equal(isProtectedPath("server.key"), true);

	// Safe files
	assert.equal(isProtectedPath("src/index.ts"), false);
	assert.equal(isProtectedPath("README.md"), false);
	assert.equal(isProtectedPath("test/routing.test.ts"), false);
	assert.equal(isProtectedPath("docs/architecture.md"), false);
});

test("isDestructiveBash identifies dangerous commands", () => {
	assert.equal(isDestructiveBash("rm -rf node_modules"), true);
	assert.equal(isDestructiveBash("rm -f -r dist"), true);
	assert.equal(isDestructiveBash("git reset --hard HEAD~1"), true);
	assert.equal(isDestructiveBash("git clean -fd"), true);
	assert.equal(isDestructiveBash("DROP TABLE users;"), true);
	assert.equal(isDestructiveBash("chmod -R 777 ."), true);

	// Safe or read-only/build commands
	assert.equal(isDestructiveBash("git status"), false);
	assert.equal(isDestructiveBash("npx tsc --noEmit"), false);
	assert.equal(isDestructiveBash("npm test"), false);
	assert.equal(isDestructiveBash("ls -la"), false);
});

test("classifyTaskRisk categorizes tasks accurately", () => {
	// Fast track
	assert.equal(classifyTaskRisk("fix typo in README"), "FAST");
	assert.equal(classifyTaskRisk("update documentation"), "FAST");
	assert.equal(classifyTaskRisk("rename variable foo to bar in state.ts"), "FAST");
	assert.equal(classifyTaskRisk("add unit test for routing helper"), "FAST");
	assert.equal(classifyTaskRisk("small patch to handle null check"), "FAST");

	// Gated track
	assert.equal(classifyTaskRisk("run database migration for user table"), "GATED");
	assert.equal(classifyTaskRisk("update dependencies in package.json"), "GATED");
	assert.equal(classifyTaskRisk("configure github actions ci/cd workflow"), "GATED");
	assert.equal(classifyTaskRisk("implement auth secrets token handling"), "GATED");
	assert.equal(classifyTaskRisk("touch something", ["package.json"]), "GATED");
	assert.equal(classifyTaskRisk("touch something", [".github/workflows/ci.yml"]), "GATED");

	// Standard track (multi-step, architectural, feature)
	assert.equal(classifyTaskRisk("implement full subagent retry queue and backoff algorithm across dispatchers"), "STANDARD");
	assert.equal(classifyTaskRisk("refactor the task execution pipeline to support streaming events"), "STANDARD");
});
