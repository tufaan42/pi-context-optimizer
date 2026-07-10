/**
 * bridge.ts — Stable discovery pointer for host integration (the filesystem
 * artifact protocol).
 *
 * The single source of truth for host integration is the on-disk artifact
 * directory (<cwd>/.pi/context-optimizer/<session>/). Hosts that want to
 * discover the ACTIVE session's directory without globbing watch one stable
 * file written here: <cwd>/.pi/context-optimizer/active.json.
 *
 * active.json is ADDITIVE — it mirrors status.json plus the absolute
 * artifactDir. It is written on every phase transition (via index.ts
 * writeStatus) and on session resume. Hosts may also read per-session
 * status.json directly. See BRIDGE.md for the full contract.
 *
 * Everything here is pure + best-effort: a write/read failure degrades
 * gracefully (the workflow never blocks on this pointer).
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const ACTIVE_FILE = "active.json";

/** The active.json shape — a stable, host-readable pointer to the live session. */
export interface ActivePointer {
	/** Absolute path to the active session's artifact directory. */
	artifactDir: string;
	/** Current phase (mirrors status.json): INERT | RESEARCHING | PLAN_DRAFTING | REVIEW_PENDING | EXECUTING. */
	phase: string;
	/** Approval state (mirrors status.json): none | pending | approved | rejected. */
	approval: string;
	/** Completed step count. */
	done: number;
	/** Total step count. */
	total: number;
	/** ISO timestamp of the last update. */
	updatedAt: string;
}

/** Input for writeActivePointer (updatedAt is stamped here). */
export interface ActivePointerInput {
	artifactDir: string;
	phase: string;
	approval: string;
	done: number;
	total: number;
}

/** Stable path to the active-session pointer: <cwd>/.pi/context-optimizer/active.json */
export function activeFilePath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "context-optimizer", ACTIVE_FILE);
}

/**
 * Atomically write (overwrite) the active.json pointer. Writes are queued via
 * withFileMutationQueue to avoid torn writes; parent dirs are created.
 * Throws on filesystem errors so callers can decide to swallow — index.ts
 * wraps every call in try/catch so a failure never breaks the workflow.
 */
export async function writeActivePointer(cwd: string, input: ActivePointerInput): Promise<void> {
	const path = activeFilePath(cwd);
	const payload: ActivePointer = {
		artifactDir: input.artifactDir,
		phase: input.phase,
		approval: input.approval,
		done: input.done,
		total: input.total,
		updatedAt: new Date().toISOString(),
	};
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
	});
}

/**
 * Read + validate active.json. Returns null when missing or malformed (never
 * throws) so callers can treat an absent pointer as "no active session yet".
 */
export async function readActivePointer(path: string): Promise<ActivePointer | null> {
	if (!existsSync(path)) return null;
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ActivePointer>;
		if (
			typeof parsed?.artifactDir === "string" &&
			typeof parsed?.phase === "string" &&
			typeof parsed?.approval === "string" &&
			typeof parsed?.done === "number" &&
			typeof parsed?.total === "number" &&
			typeof parsed?.updatedAt === "string"
		) {
			return {
				artifactDir: parsed.artifactDir,
				phase: parsed.phase,
				approval: parsed.approval,
				done: parsed.done,
				total: parsed.total,
				updatedAt: parsed.updatedAt,
			};
		}
		return null;
	} catch {
		return null;
	}
}

// `rm` is re-exported so tests (and future callers) can clean up pointer trees
// without an extra import; it is not used by the extension itself.
export { rm };
