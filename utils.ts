/**
 * Pure utilities for the pi-antigravity extension.
 *
 * The bash-safety classifier and the todo extract/mark helpers are lifted from
 * pi's bundled `examples/extensions/plan-mode/utils.ts` (same semantics) so the
 * gate behaves the same as the reference design. They are kept pure and
 * dependency-free so they can be unit-tested in isolation.
 */

import { basename, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Artifact directory layout
// ---------------------------------------------------------------------------

/**
 * Directory that holds all plan artifacts for one session.
 *
 *   <cwd>/.pi/antigravity/<session-basename>/
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
	return join(cwd, CONFIG_DIR_NAME, "antigravity", name);
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
	status: "pending" | "in_progress" | "done";
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
		const text = raw.trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 3 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			items.push({ step: items.length + 1, text, status: "pending" });
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
		const box = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[/]" : "[ ]";
		lines.push(`- ${box} ${t.step}. ${t.text}`);
	}
	if (tasks.length === 0) lines.push("_(no tasks yet)_");
	return lines.join("\n") + "\n";
}