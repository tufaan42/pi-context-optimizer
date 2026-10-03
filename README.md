<div align="center">

# 🌀 pi-context-optimizer

**Plan → Review → Execute → Walkthrough** — a structured, gate-driven workflow loop for the [pi coding agent](https://github.com/earendil-works/pi).

[![npm version](https://img.shields.io/npm/v/pi-context-optimizer?color=%2344cc11&label=npm)](https://www.npmjs.com/package/pi-context-optimizer)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js)](package.json)
[![Pi](https://img.shields.io/badge/pi-%E2%89%A50.78.0-%23FF6F00)](https://github.com/earendil-works/pi)

---

</div>

## ✨ What is it?

**pi-context-optimizer** brings an **adaptive, risk-routed workflow** to the `pi` coding agent. Rather than enforcing a rigid review gate for every small change, it dynamically routes tasks across three specialized execution tracks:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ADAPTIVE WORKFLOW TRACKS                              │
│                                                                             │
│  ⚡ FAST TRACK (Simple tasks, ≤2 files, no config/deps):                    │
│     INERT ──/fast──▶ EXECUTING ──invariants check──▶ write_walkthrough     │
│                                                                             │
│  🔄 STANDARD TRACK (Multi-step features & refactors):                        │
│     INERT ──/plan──▶ RESEARCHING ──write_plan──▶ AUTO-APPROVE ──▶ DAG EXEC  │
│                                                                             │
│  🛡️ GATED TRACK (High-risk, database migrations, CI, protected files):       │
│     INERT ──/plan──▶ RESEARCHING ──write_plan──▶ REVIEW_PENDING ──/approve │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **⚡ Fast Track (`Execute → Walkthrough`)**: For typos, single-file bugfixes, local tests, and small patches. Bypasses `plan.md` and manual review completely. Enters execution immediately, verifies with deterministic project gates (`tsc`, `pytest`, `go test`), and writes an auditable `walkthrough.md`.
- **🔄 Standard Track (`Plan → Auto-Approve → Execute → Walkthrough`)**: Drafts `plan.md` and displays it in VS Code, auto-approves execution without blocking the user, and runs concurrent DAG subagents.
- **🛡️ Gated Track (`Plan → Review → Execute → Walkthrough`)**: Enforces a strict blocking lock awaiting `/approve` for sensitive tasks (dependencies, migrations, CI workflows, or destructive operations).
- **🚨 Mid-Run Escalation**: If a Fast Track execution touches protected files, exceeds the 2-file blast radius, or fails invariant gates, mutations freeze instantly and escalate to `REVIEW_PENDING`.

---

## 📋 Prerequisites

To use `pi-context-optimizer`, ensure you have the following:

1. **Node.js**: `node >= 18`
2. **Pi Coding Agent**: `pi >= 0.78.0` installed globally or locally.
3. **Sub-agent Infrastructure**:
   - **`nicobailon/pi-subagents`** (`pi-subagents` package on npm: https://github.com/nicobailon/pi-subagents) for executing child agent sessions.
   - **`tsedr-runtime`** (`T-SEDR`) configured globally or locally to hook into agent sessions.
4. **VS Code Extension** (Optional): **`tufaan42.pi-context-optimizer`** for human-in-the-loop plan reviews and approval controls directly in the IDE.
5. **Peer Dependencies**:
   - `@earendil-works/pi-coding-agent >= 0.78.0`
   - `@earendil-works/pi-tui >= 0.78.0`
   - `typebox >= 1.1.0`

---

## 🚀 Step-by-Step Integration Guide

### Step 1: Install the Extension

Install `pi-context-optimizer` in your project or globally alongside `pi`:

```bash
npm install pi-context-optimizer
```

### Step 2: Configure `pi` to Load the Extension

Add the extension name to your configuration. You can do this at the project level or globally.

#### Option A: Project-Level Configuration (Recommended)
Create a `.pirc.json` file in the root of your workspace:

```json
{
  "extensions": [
    "pi-context-optimizer"
  ]
}
```

#### Option B: Global Configuration
Add the extension to `~/.pi/config.json`:

```json
{
  "extensions": [
    "pi-context-optimizer"
  ]
}
```

### Step 3: Run the `pi` Agent

Launch `pi` in your workspace. You should see an initialization message confirming the optimizer is loaded:

```text
[CONTEXT OPTIMIZER] pi-context-optimizer is loaded. Use /plan to start a structured plan→review→execute→walkthrough workflow, or just start coding normally.
```

---

## 🧑‍💻 Using the Workflow

### Interactive Slash Commands

The extension registers the following commands to control the workflow:

| Command | Phase / Track | Description |
|---------|---------------|-------------|
| `/fast` | `INERT` → `EXECUTING` (Fast) | Enter Fast Track: direct execution without plan review (Execute → Walkthrough). |
| `/plan` | `INERT` → `RESEARCHING` (Gated) | Enter read-only research mode to draft a plan with human review. |
| `/grill` | `RESEARCHING` / `PLAN_DRAFTING` | Open an interactive grill/interview session to align details. |
| `/done` | `PLAN_DRAFTING` | Exit grill mode and indicate readiness to finalize the plan. |
| `/approve` | `REVIEW_PENDING` → `EXECUTING` | Approve the pending plan, opening write permissions. |
| `/reject` | `REVIEW_PENDING` → `PLAN_DRAFTING` | Reject the plan and provide feedback for a revision. |
| `/status` | Any | Show current phase, track, review mode, and progress. |
| `/reset` | Any → `INERT` | Clean all session artifacts and reset to inert state. |

### CLI Flags

You can customize the initial track and review mode when starting `pi`:

```bash
# Start in Fast Track mode for quick localized tasks
pi --ag-fast "Fix typo in README.md"

# Start in planning mode with structured review
pi --ag-plan "Refactor the database layer to use Drizzle ORM"

# Configure review gating policy: 'auto' (default), 'always' (strict), or 'never' (autonomous)
pi --ag-review=auto
```

---

## 📁 Artifact Structure

During the session, `pi-context-optimizer` creates structured artifacts under `.pi/context-optimizer/<session-id>/`:

- **`plan.md`**: The human-reviewable implementation plan.
- **`tasks.md`**: A live checklist representing step progress.
- **`walkthrough.md`**: A summary of changes and verification results.
- **`status.json`**: Machine-readable state representing phase/approval.
- **`knowledge/`**: Directory containing cross-session knowledge items.

---

## 🔗 Host Integration (Bridge)

`pi-context-optimizer` is **host-agnostic**: any tool built on `pi` — the
original `pithings/pi-vscode` extension, **PiLot Studio**, a JetBrains plugin,
or a custom web UI — can integrate the plan→review→execute→walkthrough flow
**without HTTP, tokens, or in-process embedding.**

The primary contract is the **filesystem artifact protocol**: the plan/tasks/
walkthrough/status files are always written to disk, and a stable
`active.json` pointer lets a host discover the active session by watching one
file. The approval gate is file-based — approve/reject by writing `status.json`,
which the extension reconciles via `fs.watch`.

The original pi-vscode HTTP bridge (`openFile` / `setPlanStatus`) still works
but is now a **cosmetic, auto-detected enhancement**, not a dependency. A host
that provides nothing still gets a fully functional workflow.

👉 **Full contract, schemas, and a minimal integration recipe:** see
[`BRIDGE.md`](./BRIDGE.md).

---

## 🧠 Context Optimization & Parallel Sub-agents

### Context Window Optimization
To prevent context window bloat and keep sub-agents running fast and cost-effectively, `pi-context-optimizer` implements strict context isolation:
- **Strict Context Isolation**: Sub-agents are spawned with `inherit_context: false` so they do not inherit the massive main session chat history.
- **Targeted Context Propagation**: The dispatcher constructs a minimal, highly-focused prompt for each sub-agent containing only:
  - The high-level plan summary.
  - The specific step description to execute.
  - The precise outputs of its direct and transitive prerequisite steps (predecessors in the dependency DAG).

### Parallel Sub-agent Spawning
When a plan is approved, the engine compiles the steps into a Directed Acyclic Graph (DAG) and executes independent branches concurrently:
- **DAG Resolution**: Steps that have all prerequisites completed are marked as ready.
- **Concurrent Dispatching**: Ready steps are dispatched in parallel using the `Agent` tool, adhering to a defined concurrency limit (`concurrencyLimit`).

### Framework & Registry Integration
`pi-context-optimizer` is designed to run in environments utilizing:
- **nicobailon/pi-subagents**: The core execution engine relies on the Structured Delegation API and sub-agent runner exposed by the `pi-subagents` package (https://github.com/nicobailon/pi-subagents) to spawn child tasks.
- **T-SEDR (`tsedr-runtime`)**: Fully integrates with `tsedr-runtime`. When a sub-agent session starts, T-SEDR's global `before_agent_start` hook executes within the sub-agent session to provide runtime validation and environment setup.

---

## 🔧 API Reference

### Programmatic Integration

If you are developing a custom extension wrapper for `pi`, you can import and register `pi-context-optimizer` programmatically:

```typescript
import contextOptimizer from "pi-context-optimizer";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  // Register the optimizer extension
  contextOptimizer(pi);
}
```

---

## 🧪 Development & Testing

If you are contributing to this extension:

1. Clone the repository:
   ```bash
   git clone https://github.com/tufaan42/pi-context-optimizer.git
   cd pi-context-optimizer
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development/build pipeline:
   ```bash
   npm run build      # Compile TypeScript (dist/)
   npm run typecheck  # Run type checking without emit
   npm test           # Execute unit and E2E tests
   ```

---

## 📄 License

[MIT](LICENSE) © 2026 Tufaan
