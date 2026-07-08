/**
 * Artifact openers.
 *
 * We MUST NOT rely on the model invoking `code <path>` via the bash tool — our
 * own gate blocks `code` during research (it's in plan-mode's destructive
 * list). So the extension opens artifacts itself, via one of:
 *
 *   1. If pi-vscode's bridge env is set (PI_VSCODE_BRIDGE_URL present), prefer
 *      calling the VS Code `vscode_open_file` tool back through the bridge.
 *      We do this by spawning the registered tool? No — extensions can't call
 *      other extensions' tools directly. Instead we POST to the bridge's
 *      `/rpc` `openFile` method ourselves (same token pi-vscode uses).
 *   2. Otherwise fall back to `pi.exec("code", [path])` — still allowed because
 *      *we* invoke it, not the model: pi.exec is not subject to `tool_call`.
 *
 * Both paths are best-effort; failure to open does NOT block the plan workflow
 * (the file is on disk either way and the user can open it manually).
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VSCODE_BRIDGE_URL = process.env.PI_VSCODE_BRIDGE_URL;
const VSCODE_BRIDGE_TOKEN = process.env.PI_VSCODE_BRIDGE_TOKEN;

/** Open a file in VS Code, preferring the pi-vscode bridge when present. */
export async function openArtifactInVSCode(pi: ExtensionAPI, absPath: string, preview = true): Promise<void> {
	// Path 1: pi-vscode bridge present — POST to its /rpc openFile endpoint.
	if (VSCODE_BRIDGE_URL && VSCODE_BRIDGE_TOKEN) {
		try {
			const res = await fetch(`${VSCODE_BRIDGE_URL}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-pi-vscode-authorization": VSCODE_BRIDGE_TOKEN,
				},
				body: JSON.stringify({ method: "openFile", params: { filePath: absPath, preview } }),
			});
			if (res.ok) return;
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
	} catch {
		// best-effort; ignore
	}
}

/** Notify VS Code side of plan status (best-effort) so the status bar updates. */
export async function pushPlanStatusToVSCode(status: Record<string, unknown>): Promise<void> {
	if (!VSCODE_BRIDGE_URL || !VSCODE_BRIDGE_TOKEN) return;
	try {
		await fetch(`${VSCODE_BRIDGE_URL}/rpc`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-pi-vscode-authorization": VSCODE_BRIDGE_TOKEN,
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