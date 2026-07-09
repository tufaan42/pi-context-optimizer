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

**pi-context-optimizer** brings a structured **human-in-the-loop** workflow to the `pi` coding agent. Instead of letting the agent code freely from the start, this extension enforces a disciplined five-phase cycle to optimize context, prevent runaway file writes, and align on goals before execution:

```
┌─────────────────────────────────────────────────────────────┐
│                      5-PHASE LOOP                          │
│                                                             │
│   INERT ──/plan──▶ RESEARCHING ──write_plan──▶ PLAN_DRAFTING │
│                                                   │         │
│                                                   ▼         │
│   EXECUTING ◀───/approve─────────────── REVIEW_PENDING      │
│       │                                                     │
│       └── all done ──write_walkthrough──▶ INERT              │
└─────────────────────────────────────────────────────────────┘
```

During **RESEARCHING** / **PLAN_DRAFTING** / **REVIEW_PENDING**, the agent is **blocked** from editing code — it can only read, explore, and reason. Once a plan is written and **you approve it**, the gates open and the agent executes step-by-step, reporting progress after each step.

Perfect for:
- 🎯 **Complex, multi-step refactors** where you want a plan before any code changes
- 🧪 **Code reviews with an AI** — see the plan, approve or reject, then watch it execute
- 📚 **Knowledge capture** — the walkthrough artifact persists what changed and why
- 🤝 **Collaborative sessions** — `/grill` mode to interview the agent before it drafts

---

## 📋 Prerequisites

To use `pi-context-optimizer`, ensure you have the following:

1. **Node.js**: `node >= 18`
2. **Pi Coding Agent**: `pi >= 0.78.0` installed globally or locally.
3. **Sub-agent Infrastructure**:
   - **`kmmuntasir/pi-nested-subagents:src`** (or configured sub-agent tools on the agent system) for executing nested agent sessions.
   - **`tsedr-runtime`** (`T-SEDR`) configured globally or locally to hook into agent sessions.
4. **Peer Dependencies**:
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

| Command | Phase | Description |
|---------|-------|-------------|
| `/plan` | `INERT` → `RESEARCHING` | Enter read-only research mode to draft a plan. |
| `/grill` | `RESEARCHING` / `PLAN_DRAFTING` | Open an interactive grill/interview session to align details. |
| `/done` | `PLAN_DRAFTING` | Exit grill mode and indicate readiness to finalize the plan. |
| `/approve` | `REVIEW_PENDING` → `EXECUTING` | Approve the plan, opening write permissions. |
| `/reject` | `REVIEW_PENDING` → `PLAN_DRAFTING` | Reject the plan and provide feedback for a revision. |

### CLI Flag

You can also start a session auto-booted in planning mode:

```bash
pi --ag-plan "Refactor the database layer to use Drizzle ORM"
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
- **kmmuntasir/pi-nested-subagents**: The core execution engine relies on the nested sub-agent spawning API (`Agent` tool) exposed by the `kmmuntasir/pi-nested-subagents:src` package to spawn child tasks.
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
