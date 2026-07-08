/**
 * Approval reconciliation — the human review gate.
 *
 * pi-vscode's bridge is one-directional (pi → VS Code over HTTP fetch; there
 * is NO VS-Code → running-pi push channel), and in the Chat Participant path
 * (`--mode rpc`, `src/chat.ts:120-125`) pi's `ctx.ui.select`/`confirm` prompts
 * are auto-**cancelled**. So the approval gate must NOT block on a TUI modal.
 *
 * The single source of truth is `status.json` next to the plan. BOTH the
 * `/approve` and `/reject` slash commands in pi AND the `Pi: Approve Plan` /
 * `Pi: Reject Plan` commands in VS Code write the same `approval` field; a
 * debounced `fs.watch` on that file reconciles either path into the live
 * state machine in `index.ts`.
 */

import { existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STATUS_FILE } from "./utils.ts";
import type { StatusFile } from "./state.ts";

type WatchCallback = (status: StatusFile) => void;

export interface ApprovalWatcher {
	stop(): void;
}

/**
 * Watch `<artifactDir>/status.json` for changes and call `cb` with the parsed
 * status. Debounced (worst case a single atomic write may fire multiple events).
 * No-op (returns a stub) if the file does not exist yet; calling `start` again
 * after the plan file appears is handled by `index.ts`.
 */
export function startStatusWatch(artifactDir: string, cb: WatchCallback): ApprovalWatcher {
	const statusPath = join(artifactDir, STATUS_FILE);
	if (!existsSync(statusPath)) {
		return { stop() {} };
	}

	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let watcher: ReturnType<typeof watch> | null = null;
	try {
		watcher = watch(statusPath, () => {
			if (stopped) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void readStatus(statusPath).then((s) => {
					if (s) cb(s);
				});
			}, 120);
		});
	} catch {
		// Some platforms can't watch; the command path still works.
		return { stop() {} };
	}

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			watcher?.close();
		},
	};
}

export async function readStatus(statusPath: string): Promise<StatusFile | null> {
	try {
		const raw = await readFile(statusPath, "utf-8");
		const parsed = JSON.parse(raw) as StatusFile;
		if (typeof parsed?.approval === "string" && typeof parsed?.phase === "string") {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

/** Write the `approval` field directly from a pi slash-command. Re-exported so
 * `index.ts` keeps a single write path shared with VS Code. */
export { writeFile } from "node:fs/promises";