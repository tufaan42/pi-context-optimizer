/**
 * Pure utilities for the pi-context-optimizer extension.
 *
 * The bash-safety classifier and the todo extract/mark helpers are lifted from
 * pi's bundled `examples/extensions/plan-mode/utils.ts` (same semantics) so the
 * gate behaves the same as the reference design. They are kept pure and
 * dependency-free so they can be unit-tested in isolation.
 */

import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AgTrack } from "./state.ts";

// ---------------------------------------------------------------------------
// Artifact directory layout
// ---------------------------------------------------------------------------

/**
 * Directory that holds all plan artifacts for one session.
 *
 *   <cwd>/.pi/context-optimizer/<session-basename>/
 *      plan.md
 *      tasks.md
 *      walkthrough.md
 *      status.json
 *      knowledge/   (phase 2)
 *
 * We derive a folder name from the session JSONL file's basename because pi
 * exposes no numeric conversation id — `ctx.sessionManager.getSessionFile()`
 * is the canonical identifier and is a JSONL path.
 */
export function artifactDirFor(cwd: string, sessionFile: string | null | undefined): string {
	const name = sessionFile ? safeFolderName(basename(sessionFile)) : "ad-hoc";
	return join(cwd, CONFIG_DIR_NAME, "context-optimizer", name);
}

function safeFolderName(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.jsonl?$/i, "") || "session";
}

export const PLAN_FILE = "plan.md";
export const TASKS_FILE = "tasks.md";
export const WALKTHROUGH_FILE = "walkthrough.md";
export const STATUS_FILE = "status.json";
export const KNOWLEDGE_DIR = "knowledge";

// ---------------------------------------------------------------------------
// Bash safety classifier (ported from examples/extensions/plan-mode/utils.ts)
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/** True only if the command is both non-destructive AND explicitly allowlisted. */
export function isSafeReadonlyCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// ---------------------------------------------------------------------------
// Tasks (todo) handling — also ported from plan-mode for parity
// ---------------------------------------------------------------------------

export interface TaskItem {
	step: number;
	text: string;
	status: "pending" | "in_progress" | "done" | "failed";
	dependencies?: number[];
}

export function extractTaskItems(message: string): TaskItem[] {
	const items: TaskItem[] = [];
	const headerMatch = message.match(/\*{0,2}(?:Plan|Tasks?):\*{0,2}\s*\n/i);
	if (!headerMatch) return items;
	const section = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const pattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	for (const match of section.matchAll(pattern)) {
		const raw = match[2];
		if (!raw) continue;
		let text = raw.trim().replace(/\*{1,2}$/, "").trim();
		const depMatch = text.match(/\(depends?:\s*([\d,\s]+)\)/i);
		let dependencies: number[] = [];
		if (depMatch) {
			dependencies = depMatch[1]!
				.split(",")
				.map((s) => parseInt(s.trim(), 10))
				.filter((n) => Number.isFinite(n) && n > 0);
			text = text.replace(/\(depends?:\s*([\d,\s]+)\)/i, "").trim();
		}
		if (text.length > 3 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			items.push({ step: items.length + 1, text, status: "pending", dependencies });
		}
	}
	return items;
}

export function markDoneSteps(text: string, items: TaskItem[]): number {
	let changed = 0;
	for (const m of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(m[1]);
		if (!Number.isFinite(step)) continue;
		const item = items.find((t) => t.step === step);
		if (item && item.status !== "done") {
			item.status = "done";
			changed++;
		}
	}
	return changed;
}

/** Render a tasks.md checklist body. */
export function renderTasksMd(tasks: TaskItem[]): string {
	const lines: string[] = ["# Tasks", ""];
	for (const t of tasks) {
		const box = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[/]" : t.status === "failed" ? "[-]" : "[ ]";
		const suffix = t.status === "failed" ? " (FAILED)" : "";
		lines.push(`- ${box} ${t.step}. ${t.text}${suffix}`);
	}
	if (tasks.length === 0) lines.push("_(no tasks yet)_");
	return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Repo-aware invariants gate detection
// ---------------------------------------------------------------------------

/**
 * Detect the project's deterministic invariants gate command from its files.
 *
 * Returns a shell command string to run before declaring a step done, or null
 * if no recognized project type was found. The command is defensive: any
 * read/parse error yields null (the protocol tells the sub-agent to skip the
 * gate if none was provided).
 *
 * Detection order:
 *   - tsconfig.json  → npx tsc --noEmit  (+ lint script from package.json)
 *   - go.mod          → go vet ./... && go build ./...
 *   - pyproject.toml / setup.py → ruff check .  (+ mypy . if mypy config exists)
 */
export function detectInvariantsGate(cwd: string): string | null {
	try {
		if (existsSync(join(cwd, "tsconfig.json"))) {
			const parts = ["npx tsc --noEmit"];
			// Try to read the lint script from package.json
			const pkgPath = join(cwd, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					const lintScript = pkg?.scripts?.lint;
					if (typeof lintScript === "string" && lintScript.trim()) {
						parts.push(lintScript);
					}
				} catch { /* ignore parse error */ }
			}
			return parts.join(" && ");
		}
		if (existsSync(join(cwd, "go.mod"))) {
			return "go vet ./... && go build ./...";
		}
		if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
			const parts = ["ruff check ."];
			// Check for mypy config (mypy.ini, .mypy.ini, or [tool.mypy] in pyproject.toml)
			const hasMypyConfig =
				existsSync(join(cwd, "mypy.ini")) ||
				existsSync(join(cwd, ".mypy.ini")) ||
				(existsSync(join(cwd, "pyproject.toml")) &&
					readFileSync(join(cwd, "pyproject.toml"), "utf8").includes("[tool.mypy]"));
			if (hasMypyConfig) parts.push("mypy .");
			return parts.join(" && ");
		}
	} catch {
		/* defensive: any error → null */
	}
	return null;
}

// ---------------------------------------------------------------------------
// Adaptive Routing & Safety Guards
// ---------------------------------------------------------------------------

export const FAST_TRACK_MAX_FILES = 2;

const PROTECTED_EXACT_NAMES = new Set([
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"poetry.lock",
	"requirements.txt",
	"requirements-dev.txt",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"Jenkinsfile",
	"schema.prisma",
]);

const PROTECTED_SUBPATHS = [
	"/.github/workflows/",
	"/.gitlab-ci.yml",
	"/migrations/",
	"/alembic/",
	"/db/migrate/",
];

const PROTECTED_EXTENSIONS_OR_PATTERNS = [
	/^\.env(\..+)?$/i,
	/^tsconfig(\..+)?\.json$/i,
	/^(vite|webpack|rollup|next|babel|turbo)\.config\.[a-z0-9]+$/i,
	/\.(pem|key|crt)$/i,
];

/** Check if a file path points to sensitive project infrastructure. */
export function isProtectedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const name = basename(normalized);

	if (PROTECTED_EXACT_NAMES.has(name)) return true;

	for (const pattern of PROTECTED_EXTENSIONS_OR_PATTERNS) {
		if (pattern.test(name)) return true;
	}

	for (const sub of PROTECTED_SUBPATHS) {
		if (normalized.includes(sub) || normalized.startsWith(sub.slice(1))) return true;
	}

	return false;
}

const HARD_DESTRUCTIVE_BASH = [
	/\brm\s+.*(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)\b/i,
	/\brmdir\b/i,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+.*--force)/i,
	/\b(drop\s+database|drop\s+table|truncate\s+table)\b/i,
	/\bmkfs\b/i,
	/\bdd\s+if=/i,
	/\bshred\b/i,
	/\bchmod\s+-R\s+777\b/i,
];

/** Check if a bash command is explicitly destructive. */
export function isDestructiveBash(command: string): boolean {
	return HARD_DESTRUCTIVE_BASH.some((p) => p.test(command));
}

const HIGH_RISK_PROMPT_KEYWORDS = [
	/\bmigrat(e|ion|ions)\b/i,
	/\bdatabase\b/i,
	/\b(drop|truncate|delete)\s+(table|database|schema)\b/i,
	/\bdeploy(ment)?\b/i,
	/\bci\/?cd\b/i,
	/\bworkflow\b/i,
	/\b(secret|token|credential|api[-_]key)\b/i,
	/\bauth(entication)?\b/i,
	/\b(upgrade|install|uninstall|remove)\s+(deps?|dependenc(y|ies)|packages?)\b/i,
	/\bpackage\.json\b/i,
	/\btsconfig(\.json)?\b/i,
];

const LOW_RISK_PROMPT_KEYWORDS = [
	/\b(fix\s+)?typo\b/i,
	/\b(update|fix)\s+(readme|docs?|documentation)\b/i,
	/\brename\s+(variable|function|method|class|constant|field)\b/i,
	/\b(add|fix|update)\s+(a\s+)?(test|unit\s*test|spec)\b/i,
	/\bcomment(s)?\b/i,
	/\bquick\s+fix\b/i,
	/\bsmall\s+(fix|change|patch)\b/i,
	/\bone[- ]line\b/i,
];

/** Classify a task prompt into FAST, STANDARD, or GATED track. */
export function classifyTaskRisk(prompt: string, contextFiles: string[] = []): AgTrack {
	// Any protected context file -> GATED immediately
	for (const f of contextFiles) {
		if (isProtectedPath(f)) return "GATED";
	}

	// High risk prompt triggers
	for (const pattern of HIGH_RISK_PROMPT_KEYWORDS) {
		if (pattern.test(prompt)) return "GATED";
	}

	// Low risk prompt triggers
	for (const pattern of LOW_RISK_PROMPT_KEYWORDS) {
		if (pattern.test(prompt)) return "FAST";
	}

	// Short, simple prompt with single file mention
	if (prompt.length < 100 && (prompt.includes(".") || contextFiles.length === 1)) {
		return "FAST";
	}

	return "STANDARD";
}
