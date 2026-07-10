/**
 * Artifact openers + optional HTTP bridge to a host (e.g. a VS Code extension).
 *
 * DESIGN — the filesystem artifact protocol is the source of truth.
 * The plan/tasks/walkthrough/status files are ALWAYS written to disk on every
 * phase transition (see index.ts writeStatus + tools.ts). Any host that can
 * read files and watch a directory can integrate — no HTTP, no tokens, no
 * in-process embedding required. See BRIDGE.md for the public contract.
 *
 * The HTTP bridge here (openFile / setPlanStatus) is a COSMETIC, OPTIONAL
 * enhancement. It is auto-detected from environment variables and is strictly
 * best-effort: if no bridge is configured, or the configured bridge is
 * unreachable, or the `code` CLI binary is missing, openArtifactInVSCode
 * resolves to "skipped" and NEVER throws or rejects. The files are on disk
 * regardless, so the workflow never blocks.
 *
 * Two env-var conventions are recognized (generic preferred over legacy):
 *   - Generic:  PI_CO_BRIDGE_URL / PI_CO_BRIDGE_TOKEN / PI_CO_BRIDGE_AUTH_HEADER
 *                (auth header defaults to "x-pi-bridge-authorization")
 *   - Legacy:    PI_VSCODE_BRIDGE_URL / PI_VSCODE_BRIDGE_TOKEN
 *                (auth header "x-pi-vscode-authorization") — kept for backward
 *                compatibility with the original pithings/pi-vscode bridge.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface BridgeConfig {
	url: string;
	token: string;
	authHeader: string;
}

/** Auth header names for each convention. */
const GENERIC_AUTH_HEADER_DEFAULT = "x-pi-bridge-authorization";
const LEGACY_AUTH_HEADER = "x-pi-vscode-authorization";

/** Env-var keys this module reads — exported so tests can save/restore them. */
export const BRIDGE_ENV_KEYS = [
	"PI_CO_BRIDGE_URL",
	"PI_CO_BRIDGE_TOKEN",
	"PI_CO_BRIDGE_AUTH_HEADER",
	"PI_VSCODE_BRIDGE_URL",
	"PI_VSCODE_BRIDGE_TOKEN",
] as const;

/**
 * Lazily resolve the HTTP bridge config from the environment at call time.
 * Generic env vars are preferred over the legacy pi-vscode ones when both are
 * present. Returns null when no bridge URL+token pair is configured.
 *
 * Reading at call time (not module load) keeps this testable and lets a host
 * register a bridge after startup.
 */
export function getBridgeConfig(): BridgeConfig | null {
	const genericUrl = process.env.PI_CO_BRIDGE_URL;
	const genericToken = process.env.PI_CO_BRIDGE_TOKEN;
	if (genericUrl && genericToken) {
		return {
			url: genericUrl,
			token: genericToken,
			authHeader: process.env.PI_CO_BRIDGE_AUTH_HEADER?.trim() || GENERIC_AUTH_HEADER_DEFAULT,
		};
	}
	const legacyUrl = process.env.PI_VSCODE_BRIDGE_URL;
	const legacyToken = process.env.PI_VSCODE_BRIDGE_TOKEN;
	if (legacyUrl && legacyToken) {
		return { url: legacyUrl, token: legacyToken, authHeader: LEGACY_AUTH_HEADER };
	}
	return null;
}

/** Result of an open attempt — returned so callers/tests can observe the outcome. */
export type OpenResult = "opened" | "skipped";

/**
 * Open a file in the host editor, preferring the configured HTTP bridge when
 * present, otherwise spawning the `code` CLI. ALWAYS best-effort: never throws
 * and never rejects. Returns "opened" on success, "skipped" if no path worked
 * (the file is still on disk for manual opening).
 */
export async function openArtifactInVSCode(pi: ExtensionAPI, absPath: string, preview = true): Promise<OpenResult> {
	// Path 1: HTTP bridge present — POST to its /rpc openFile endpoint.
	const cfg = getBridgeConfig();
	if (cfg) {
		try {
			const res = await fetch(`${cfg.url}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[cfg.authHeader]: cfg.token,
				},
				body: JSON.stringify({ method: "openFile", params: { filePath: absPath, preview } }),
			});
			if (res.ok) return "opened";
		} catch {
			// fall through to binary open
		}
	}

	// Path 2: spawn the `code` CLI directly. pi.exec is not subject to our
	// tool_call gate (the gate intercepts the MODEL's bash tool, not our
	// extension's process spawns).
	try {
		const codeBin = process.env.PI_AG_VSCODE_BIN ?? "code";
		await pi.exec(codeBin, [absPath], { timeout: 8 });
		return "opened";
	} catch {
		// best-effort; the file is on disk either way
	}

	return "skipped";
}

/** Notify a host of plan status over the HTTP bridge (best-effort, never rejects). */
export async function pushPlanStatusToVSCode(status: Record<string, unknown>): Promise<void> {
	const cfg = getBridgeConfig();
	if (!cfg) return;
	try {
		await fetch(`${cfg.url}/rpc`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[cfg.authHeader]: cfg.token,
			},
			body: JSON.stringify({ method: "setPlanStatus", params: status }),
		});
	} catch {
		// best-effort
	}
}

/** Atomic-ish read-modify-write helper for an artifact file. */
export async function writeArtifact(absPath: string, content: string): Promise<void> {
	const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
	await withFileMutationQueue(absPath, async () => {
		writeFile(absPath, content, "utf8");
	});
}

export async function readArtifact(absPath: string): Promise<string | null> {
	if (!existsSync(absPath)) return null;
	try {
		return await readFile(absPath, "utf8");
	} catch {
		return null;
	}
}

export function joinArtifact(dir: string, name: string): string {
	return join(dir, name);
}

export function absOrCwd(cwd: string, p: string): string {
	return resolve(cwd, p);
}
