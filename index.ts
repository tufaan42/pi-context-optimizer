/**
 * pi-context-optimizer — Context-optimizer plan→review→execute→walkthrough loop for pi.
 *
 * Builds directly on pi's bundled `examples/extensions/plan-mode` reference
 * (same gate primitives: registerFlag/registerCommand/registerShortcut,
 * setActiveTools, tool_call blocking, before_agent_start context injection,
 * agent_end extraction, turn_end [DONE:n] tracking, appendEntry + session_start
 * resume). What it adds over plan-mode:
 *
 *   - File-backed artifacts (plan.md / tasks.md / walkthrough.md / status.json)
 *   - A REVIEW_PENDING hard gate with file-watch + slash-command approval
 *   - Opening artifacts in VS Code via the pithings/pi-vscode bridge (or `code`)
 *   - A `/grill` interactive-interview plan-drafting mode
 *   - (phase 2) a Knowledge Item store
 *
 * The gate can run in two transports:
 *   - pi-vscode terminal/Chat Participant: approval flips a file marker + a
 *     slash command; NEVER relies on a TUI modal (the Chat path auto-cancels
 *     ctx.ui.select — see pithings/pi-vscode src/chat.ts:120-125).
 *   - Bare terminal: same, plus an optional ctx.ui.select prompt at agent_end.
 *
 * See /Users/admin/.pi/plans/review-2026-07-09/plan.md for the design doc.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isSafeReadonlyCommand, markDoneSteps, extractTaskItems, type TaskItem } from "./utils.ts";
import {
	artifactDirFor,
	PLAN_FILE,
	STATUS_FILE,
} from "./utils.ts";
import { registerTools, type ToolDeps } from "./tools.ts";
import {
	defaultState,
	fromPersisted,
	toPersisted,
	type AgState,
	type StatusFile,
} from "./state.ts";
import { startStatusWatch, readStatus, type ApprovalWatcher } from "./approval.ts";
import { openArtifactInVSCode, pushPlanStatusToVSCode } from "./open.ts";
import { writeActivePointer } from "./bridge.ts";

import { Dispatcher } from "./dispatcher.ts";

const PERSIST_TYPE = "context-optimizer";

// Tools available (removed/restored by setActiveTools per phase).
const RESEARCH_TOOLS_BASE = new Set([
	"read", "bash", "grep", "find", "ls", "agent", // read-only exploration + subagents
	"write_plan", "write_knowledge_item",
]);
const PLANDRAFT_TOOLS = new Set([
	"read", "bash", "grep", "find", "ls", "agent",
	"write_plan", "write_knowledge_item",
]);
const EXECUTE_TOOLS_ENSURE = new Set([
	"write_plan" /* not callable in EXEC but harmless to keep */, "update_tasks",
	"write_walkthrough", "write_knowledge_item",
]);
const PLAN_MANAGED_TOOLS = new Set<string>([
	...RESEARCH_TOOLS_BASE, ...PLANDRAFT_TOOLS, ...EXECUTE_TOOLS_ENSURE,
]);
// Built-in mutating tools gated away during non-EXECUTE phases.
const MUTATING_BUILTIN = new Set(["edit", "write"]);

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

export default function contextOptimizerExtension(pi: ExtensionAPI): void {
	let state: AgState = defaultState();
	let tasks: TaskItem[] = [];
	let toolsBefore: string[] | undefined; // tool set captured on entering plan mode
	let watcher: ApprovalWatcher | null = null;

	// -----------------------------------------------------------------
	// State mutators + persistence
	// -----------------------------------------------------------------
	function setState(next: AgState): void {
		state = next;
		pi.appendEntry(PERSIST_TYPE, toPersisted(state));
	}

	function artifactDir(): string | null {
		return state.artifactDir;
	}

	async function writeStatus(partial: Partial<StatusFile>): Promise<void> {
		const dir = artifactDir();
		if (!dir) return;
		const path = join(dir, STATUS_FILE);
		let current: StatusFile | null = null;
		try {
			current = await readStatus(path);
		} catch {
			/* ignore */
		}
		const status: StatusFile = {
			phase: partial.phase ?? current?.phase ?? state.phase,
			approval: partial.approval ?? current?.approval ?? "none",
			done: partial.done ?? current?.done ?? 0,
			total: partial.total ?? current?.total ?? 0,
			updatedAt: new Date().toISOString(),
			...(partial.reason !== undefined ? { reason: partial.reason } : current?.reason ? { reason: current.reason } : {}),
		};
		await mkdir(dir, { recursive: true });
		await writeFile(path, JSON.stringify(status, null, 2) + "\n", "utf8");
		await pushPlanStatusToVSCode({
			state: status.phase, approval: status.approval, done: status.done, total: status.total,
		});
		// Mirror to the stable active.json pointer (host discovery). Best-effort:
		// a failure here must never break the workflow.
		try {
			await writeActivePointer(currentCtx().cwd, {
				artifactDir: dir, phase: status.phase, approval: status.approval, done: status.done, total: status.total,
			});
		} catch { /* best-effort */ }
	}

	function refreshWatcher(): void {
		watcher?.stop();
		const dir = artifactDir();
		if (!dir) {
			watcher = null;
			return;
		}
		watcher = startStatusWatch(dir, (s) => {
			void reconcileStatus(s);
		});
	}

	/** Apply a freshly-read status.json to the live state machine. */
	async function reconcileStatus(s: StatusFile): Promise<void> {
		// Approve
		if (s.approval === "approved" && state.phase === "REVIEW_PENDING") {
			await beginExecution();
		} else if (s.approval === "rejected" && state.phase === "REVIEW_PENDING") {
			await rejectPlan(s.reason ?? "rejected by reviewer");
		}
	}

	// -----------------------------------------------------------------
	// Tool-set switching (mirrors plan-mode)
	// -----------------------------------------------------------------
	function unique(a: string[]): string[] {
		return [...new Set(a)];
	}
	function withoutManaged(tools: string[]): string[] {
		return tools.filter((t) => !PLAN_MANAGED_TOOLS.has(t));
	}
	function researchToolSet(active: string[]): string[] {
		return unique([...active.filter((t) => !MUTATING_BUILTIN.has(t)), ...RESEARCH_TOOLS_BASE]);
	}
	function executeToolSet(active: string[]): string[] {
		// EXECUTING keeps the prior tool set (incl edit/write) but ensures our task tools.
		return unique([...active, ...EXECUTE_TOOLS_ENSURE]);
	}
	function restoreToolSet(): void {
		pi.setActiveTools(toolsBefore ?? []);
	}

	// -----------------------------------------------------------------
	// Phase transitions
	// -----------------------------------------------------------------
	function beginResearch(ctx: ExtensionContext, sessionFile: string | null | undefined): void {
		const dir = artifactDirFor(ctx.cwd, sessionFile);
		state = { phase: "RESEARCHING", artifactDir: dir, interview: false };
		if (toolsBefore === undefined) toolsBefore = pi.getActiveTools();
		pi.setActiveTools(researchToolSet(toolsBefore)); // drops edit/write
		pi.appendEntry(PERSIST_TYPE, toPersisted(state));
		void mkdir(dir, { recursive: true });
		updateStatus(ctx);
	}

	let dispatcher: Dispatcher | null = null;

	async function beginExecution(): Promise<void> {
		const active = pi.getActiveTools();
		pi.setActiveTools(executeToolSet(active));
		setState({ ...state, phase: "EXECUTING", interview: false, dispatcherActive: true });
		await writeStatus({ phase: "EXECUTING", approval: "approved" });
		watcher?.stop();
		watcher = null;

		const dir = artifactDir();
		if (dir) {
			try {
				const planMarkdown = await readFile(join(dir, PLAN_FILE), "utf8");
				dispatcher = new Dispatcher(pi, currentCtx(), planMarkdown, dir);
				await dispatcher.init();
				void dispatcher.dispatchReady();
			} catch (e) {
				currentCtx().ui.notify(`Failed to launch dispatcher: ${e}`, "error");
			}
		}

		pi.sendMessage(
			{ customType: "ag-approved", content: "Plan approved. DAG Dispatcher launched.", display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	async function rejectPlan(reason: string): Promise<void> {
		setState({ ...state, phase: "PLAN_DRAFTING", interview: false, dispatcherActive: false });
		await writeStatus({ phase: "PLAN_DRAFTING", approval: "rejected", reason });
		pi.sendMessage(
			{
				customType: "ag-rejected",
				content: `Plan rejected: ${reason}\nRevise the plan with write_plan and resubmit.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// -----------------------------------------------------------------
	// UI status
	// -----------------------------------------------------------------
	function updateStatus(ctx: ExtensionContext): void {
		if (state.phase === "EXECUTING" && tasks.length > 0) {
			const done = tasks.filter((t) => t.status === "done").length;
			ctx.ui.setStatus("ag", ctx.ui.theme.fg("accent", `ag:exec ${done}/${tasks.length}`));
		} else if (state.phase === "REVIEW_PENDING") {
			ctx.ui.setStatus("ag", ctx.ui.theme.fg("warning", "ag:await-review"));
		} else if (state.phase === "RESEARCHING" || state.phase === "PLAN_DRAFTING") {
			const tag = state.interview ? "grill" : "plan";
			ctx.ui.setStatus("ag", ctx.ui.theme.fg("warning", `ag:${tag}`));
		} else {
			ctx.ui.setStatus("ag", undefined);
		}
	}

	// -----------------------------------------------------------------
	// Tool deps for tools.ts
	// -----------------------------------------------------------------
	const deps: ToolDeps = {
		getState: () => state,
		setState: (next) => {
			setState(next);
		},
		async onPlanSubmitted() {
			await writeStatus({ phase: "REVIEW_PENDING", approval: "pending", total: 0, done: 0 });
			refreshWatcher();
			updateStatus(currentCtx());
		},
		async onTasksUpdated(done, total) {
			await writeStatus({ done, total, phase: "EXECUTING" });
			updateStatus(currentCtx());
		},
		async onWalkthroughWritten() {
			await writeStatus({ phase: "INERT", approval: "none", done: tasks.filter((t) => t.status === "done").length, total: tasks.length });
			watcher?.stop();
			watcher = null;
			dispatcher = null;
			updateStatus(currentCtx());
		},
		getDispatcherStatus() {
			return dispatcher ? dispatcher.getStatus() : null;
		}
	};
	registerTools(pi, deps);

	// Hold the latest ExtensionContext for callback paths that lack one.
	let _ctx: ExtensionContext | null = null;
	function currentCtx(): ExtensionContext {
		return _ctx as ExtensionContext;
	}

	// -----------------------------------------------------------------
	// Flags / commands / shortcuts
	// -----------------------------------------------------------------
	pi.registerFlag("ag-plan", {
		description: "Start the session in Context Optimizer plan (read-only research) mode",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("ag-exec", {
		description: "Start the session directly in execution mode (plan already prepared)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Enter Context Optimizer plan mode (read-only research → written plan → human review)",
		handler: async (_args, ctx) => {
			beginResearch(ctx, ctx.sessionManager.getSessionFile());
			ctx.ui.notify(
				"Context Optimizer plan mode ON. Investigate the request, then call write_plan. " +
					"Editing code is blocked until /approve.",
				"info",
			);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("approve", {
		description: "Approve the pending plan and begin execution (Context Optimizer gate)",
		handler: async (_args, ctx) => {
			if (state.phase !== "REVIEW_PENDING") {
				ctx.ui.notify(`Nothing to approve — current phase is ${state.phase}.`, "warning");
				return;
			}
			await writeStatus({ approval: "approved" });
			await beginExecution(); // file-watch would also fire, but call directly to be prompt
		},
	});

	pi.registerCommand("reject", {
		description: "Reject the pending plan; send the agent back to refine it (Context Optimizer gate)",
		handler: async (args, ctx) => {
			if (state.phase !== "REVIEW_PENDING") {
				ctx.ui.notify(`Nothing to reject — current phase is ${state.phase}.`, "warning");
				return;
			}
			const reason = (args ?? "").trim() || "rejected by reviewer";
			await writeStatus({ approval: "rejected", reason });
			await rejectPlan(reason);
		},
	});

	pi.registerCommand("grill", {
		description: "Interview-driven plan drafting: ask one clarifying question at a time until /done",
		handler: async (_args, ctx) => {
			if (state.phase !== "PLAN_DRAFTING" && state.phase !== "RESEARCHING") {
				ctx.ui.notify(
					`Enter /plan first (current phase: ${state.phase}). /grill refines a pending plan.`,
					"warning",
				);
				return;
			}
			setState({ ...state, phase: "PLAN_DRAFTING", interview: true });
			ctx.ui.notify(
				"Grill mode ON. Ask one focused question now; loop until shared understanding, then /done.",
				"info",
			);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("done", {
		description: "Exit grill interview and write the plan (Context Optimizer)",
		handler: async (_args, ctx) => {
			if (!state.interview) {
				ctx.ui.notify("Not in grill mode.", "info");
				return;
			}
			setState({ ...state, interview: false });
			ctx.ui.notify("Grill done. Call write_plan to publish the plan for review.", "info");
			updateStatus(ctx);
		},
	});

	pi.registerCommand("status", {
		description: "Show current Context Optimizer phase, artifact directory, task progress, and next action",
		handler: async (_args, ctx) => {
			const dir = artifactDir() ?? "(none)";
			const lines: string[] = [
				`🌀 Context Optimizer Status`,
				`   Phase:  ${state.phase}`,
				`   Dir:    ${dir}`,
			];
			if (state.phase === "EXECUTING") {
				const done = tasks.filter((t) => t.status === "done").length;
				lines.push(`   Tasks:  ${done}/${tasks.length} done`);
			}
			const hints: Record<string, string> = {
				INERT: "Use /plan to start a structured workflow",
				RESEARCHING: "Investigate the request, then call write_plan to submit for review",
				PLAN_DRAFTING: "Write the implementation plan with write_plan, then use /approve",
				REVIEW_PENDING: "Review plan.md in VS Code, then /approve or /reject",
				EXECUTING: "Execute plan steps and call update_tasks after each; when done, write_walkthrough",
			};
			lines.push(`   Next:   ${hints[state.phase] ?? ""}`);
			if (state.interview) lines.push(`   Grill:  active (use /done to exit)`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("reset", {
		description: "Reset Context Optimizer to inert and remove all artifacts for this session",
		handler: async (_args, ctx) => {
			const dir = artifactDir();
			if (dir) {
				try {
					await rm(dir, { recursive: true, force: true });
				} catch { /* ignore */ }
			}
			restoreToolSet();
			watcher?.stop();
			watcher = null;
			tasks = [];
			setState({ phase: "INERT", artifactDir: null, interview: false });
			updateStatus(ctx);
			ctx.ui.notify("Context Optimizer reset to INERT. Artifacts cleaned.", "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle Context Optimizer plan mode",
		handler: async (ctx) => {
			if (state.phase === "INERT") {
				beginResearch(ctx, ctx.sessionManager.getSessionFile());
			} else {
				// Exit all plan phases back to inert (manual abort).
				restoreToolSet();
				setState({ ...state, phase: "INERT", interview: false });
				watcher?.stop();
				watcher = null;
			}
			updateStatus(ctx);
		},
	});

	// -----------------------------------------------------------------
	// GATE: tool_call — block mutations except to artifact dir / except EXECUTING
	// -----------------------------------------------------------------
	pi.on("tool_call", async (event) => {
		const phase = state.phase;
		const gating = phase === "RESEARCHING" || phase === "PLAN_DRAFTING" || phase === "REVIEW_PENDING";
		if (!gating) return;

		const phaseHints: Record<string, string> = {
			RESEARCHING: "Use write_plan to draft a plan, then use /approve to begin execution.",
			PLAN_DRAFTING: "Use write_plan to submit your plan for review, then /approve to execute.",
			REVIEW_PENDING: "A plan is pending review. Use /approve to accept or /reject to revise.",
		};
		if (event.toolName === "edit" || event.toolName === "write") {
			const input = event.input as { path?: string };
			const target = input.path;
			const dir = artifactDir();
			// Always allow writes inside the artifact dir (the plan/tasks themselves).
			if (target && dir && (target === dir || target.startsWith(dir + "/"))) return;
			return {
				block: true,
				reason: `Context Optimizer gate: ${event.toolName} is blocked during ${phase}. ` +
					(phaseHints[phase] ?? "Use /approve to begin execution."),
			};
		}

		if (event.toolName === "bash") {
			const input = event.input as { command?: string };
			const command = input.command ?? "";
			if (!isSafeReadonlyCommand(command)) {
				return {
					block: true,
					reason: `Context Optimizer gate: this bash command is not on the read-only allowlist for ` +
						`the ${phase} phase. ${phaseHints[phase] ?? "Use /approve to begin execution."}`,
				};
			}
		}
	});

	// -----------------------------------------------------------------
	// Per-turn context injection (mirrors plan-mode)
	// -----------------------------------------------------------------
	pi.on("before_agent_start", async () => {
		if (state.phase === "RESEARCHING" || state.phase === "PLAN_DRAFTING") {
			const grill = state.interview
				? `Ask ONE focused clarifying question now (use the questionnaire tool if present, or
simply ask in prose). Stop and wait for the answer. Do not write the plan until /done.`
				: `Investigate the request (read files, run read-only checks). Then write the full
implementation plan with the write_plan tool. Do NOT edit code — the gate blocks it.`;
			return {
				message: {
					customType: "ag-plan-context",
					content: `[CONTEXT OPTIMIZER PLAN MODE: ${state.phase}]
${grill}

After write_plan, STOP — the plan is open in VS Code for human review.
Editing code stays blocked until the user issues /approve.`,
					display: false,
				},
			};
		}
		if (state.phase === "REVIEW_PENDING") {
			return {
				message: {
					customType: "ag-review-context",
					content: `[CONTEXT OPTIMIZER REVIEW PENDING]
A plan is pending review in plan.md. The reviewer may give feedback in chat.
If they request changes, update the plan with write_plan. Do NOT edit code.
Use /approve once approved, or /reject to discard.`,
					display: false,
				},
			};
		}
		if (state.phase === "EXECUTING") {
			const statusStr = dispatcher
				? `${dispatcher.getStatus().done}/${dispatcher.getStatus().total} steps done (${dispatcher.getStatus().inFlight} running, ${dispatcher.getStatus().queued} queued)`
				: `${tasks.filter((t) => t.status === "done").length}/${tasks.length} tasks done`;
			return {
				message: {
					customType: "ag-exec-context",
					content: `[CONTEXT OPTIMIZER EXECUTING]
Status: ${statusStr}
The DAG Dispatcher is executing the tasks in parallel via autonomous sub-agents.
When all tasks are complete, write_walkthrough to finish.`,
					display: false,
				},
			};
		}

		if (state.phase === "INERT") {
			return {
				message: {
					customType: "ag-ready",
					content: "[CONTEXT OPTIMIZER] pi-context-optimizer is loaded. Use /plan to start a structured " +
						"plan\u2192review\u2192execute\u2192walkthrough workflow, or just start coding normally.",
					display: false,
				},
			};
		}

		return;
	});

	// Drop our stale context messages when we're inert (mirrors plan-mode filter)
	pi.on("context", async (event) => {
		if (state.phase !== "INERT") return;
		const ours = new Set(["ag-plan-context", "ag-review-context", "ag-exec-context", "ag-approved", "ag-rejected"]);
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return !(msg.customType && ours.has(msg.customType));
			}),
		};
	});

	// -----------------------------------------------------------------
	// turn_end — mark done steps from [DONE:n] markers
	// -----------------------------------------------------------------
	pi.on("turn_end", async (event, ctx) => {
		if (state.phase !== "EXECUTING" || tasks.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markDoneSteps(getTextContent(event.message), tasks) > 0) {
			void writeStatus({ done: tasks.filter((t) => t.status === "done").length, total: tasks.length });
			updateStatus(ctx);
		}
	});

	// -----------------------------------------------------------------
	// agent_end — re-present plan on completion of a planning turn
	// -----------------------------------------------------------------
	pi.on("agent_end", async (event, ctx) => {
		if (state.phase === "REVIEW_PENDING") {
			const planPath = artifactDir() ? join(artifactDir() as string, PLAN_FILE) : null;
			const hint = planPath
				? `Plan ready at ${planPath}. /approve to begin execution, /reject to revise, /grill for an interview.`
				: `Plan ready. /approve to begin, /reject to revise.`;
			// Use ui.notify rather than ui.select — the Chat Participant path
			// auto-cancels selects. The slash command/file-marker is the gate.
			ctx.ui.notify(hint, "info");
			return;
		}
		const isCompleted = dispatcher 
			? (dispatcher.getStatus().done + dispatcher.getStatus().failed) === dispatcher.getStatus().total
			: (tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "failed"));

		if (state.phase === "EXECUTING" && isCompleted) {
			const hasFailed = dispatcher ? dispatcher.getStatus().failed > 0 : tasks.some((t) => t.status === "failed");
			pi.sendMessage(
				{
					customType: "ag-complete",
					content: hasFailed
						? "Plan execution completed but some steps FAILED. Please review the failed tasks and call write_walkthrough to wrap up."
						: "All plan steps complete. Call write_walkthrough to finish.",
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}
	});

	// -----------------------------------------------------------------
	// session_start — restore state, restart the watcher
	// -----------------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		_ctx = ctx;
		let restored: AgState | null = null;
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === PERSIST_TYPE)
			.pop() as { data?: ReturnType<typeof toPersisted> } | undefined;
		if (last?.data) restored = fromPersisted(last.data);

		if (restored && restored.artifactDir) {
			state = restored;
		} else if (pi.getFlag("ag-plan") === true) {
			state = { phase: "RESEARCHING", artifactDir: artifactDirFor(ctx.cwd, event.previousSessionFile ?? null), interview: false };
		} else if (pi.getFlag("ag-exec") === true) {
			const agDir = artifactDirFor(ctx.cwd, event.previousSessionFile ?? null);
			state = { phase: "EXECUTING", artifactDir: agDir, interview: false, dispatcherActive: true };
		} else {
			state = defaultState();
		}

		if (state.phase === "RESEARCHING" || state.phase === "PLAN_DRAFTING" || state.phase === "REVIEW_PENDING") {
			if (toolsBefore === undefined) toolsBefore = pi.getActiveTools();
			pi.setActiveTools(researchToolSet(toolsBefore));
		} else if (state.phase === "EXECUTING") {
			pi.setActiveTools(executeToolSet(pi.getActiveTools()));
		}

		// Re-read tasks from tasks.md if present, so progress survives resume.
		const dir = state.artifactDir;
		if (dir) {
			try {
				const tasksMd = await readFile(join(dir, "tasks.md"), "utf8");
				tasks = extractTaskItems(tasksMd).map((t) => ({ ...t }));
				
				if (state.dispatcherActive) {
					const planMarkdown = await readFile(join(dir, PLAN_FILE), "utf8");
					dispatcher = new Dispatcher(pi, ctx, planMarkdown, dir);
					await dispatcher.init();
					void dispatcher.dispatchReady();
				}
			} catch {
				tasks = [];
			}
		}

		// Publish the stable active.json pointer so a host attaching mid-session
		// (or after resume) can immediately discover the active artifact dir.
		// Best-effort; subsequent writeStatus calls keep it in sync. The
		// REVIEW_PENDING branch below overwrites this with the real approval.
		if (state.artifactDir) {
			try {
				await writeActivePointer(ctx.cwd, {
					artifactDir: state.artifactDir,
					phase: state.phase,
					approval: "none",
					done: tasks.filter((t) => t.status === "done").length,
					total: tasks.length,
				});
			} catch { /* best-effort */ }
		}

		if (state.phase === "REVIEW_PENDING") {
			refreshWatcher();
			// If approval landed while we were away, honor it.
			const status = dir ? await readStatus(join(dir, STATUS_FILE)) : null;
			if (status?.approval === "approved") {
				await beginExecution();
			} else if (status?.approval === "rejected") {
				await rejectPlan(status.reason ?? "rejected before resume");
			} else {
				await writeStatus({ phase: "REVIEW_PENDING", approval: "pending" });
			}
		}

		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		watcher?.stop();
		watcher = null;
	});
}