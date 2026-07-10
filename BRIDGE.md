# Bridge — Host Integration Contract

`pi-context-optimizer` is **host-agnostic**. Any tool built on the `pi` coding
agent — a VS Code extension, a JetBrains plugin, a web UI, a CLI wrapper — can
integrate the plan→review→execute→walkthrough flow **without HTTP, without
tokens, and without being in-process.** This document is the public contract.

> The original `pithings/pi-vscode` HTTP bridge still works (auto-detected, see
> [Optional HTTP bridge](#optional-http-bridge)) but it is now a *cosmetic
> enhancement*, not a dependency. A host that provides **nothing** still gets a
> fully functional workflow — the user just opens `plan.md` manually.

---

## Why this can't fail

The workflow's source of truth is **files on disk**, written on every phase
transition regardless of any bridge:

| Artifact | Written by | Purpose |
|----------|-----------|---------|
| `<session>/plan.md` | `write_plan` tool | The reviewable plan |
| `<session>/tasks.md` | `update_tasks` / dispatcher | Live checklist |
| `<session>/walkthrough.md` | `write_walkthrough` tool | Post-run summary |
| `<session>/status.json` | every phase transition | Phase + approval + progress |
| `active.json` (stable) | every phase transition + resume | Pointer to the active session dir |

The approval gate is **file-based**: both the pi `/approve` · `/reject` slash
commands *and* any host command write the same `approval` field in
`status.json`; a debounced `fs.watch` reconciles it into the live state
machine. There is no RPC call that can time out and no bridge that can be down.

**Worst case for a host that provides nothing:** the user opens `plan.md`
themselves. The workflow never blocks.

---

## Directory layout

```
<cwd>/.pi/context-optimizer/
├── active.json                     ← STABLE pointer. Watch THIS one file.
│   {
│     "artifactDir": "<cwd>/.pi/context-optimizer/<session-basename>",
│     "phase":        "REVIEW_PENDING",
│     "approval":     "pending",
│     "done": 0, "total": 0,
│     "updatedAt": "2026-07-10T12:00:00.000Z"
│   }
└── <session-basename>/
    ├── plan.md
    ├── tasks.md
    ├── walkthrough.md
    ├── status.json
    ├── step-results/        (dispatcher: per-step sub-agent results)
    └── knowledge/           (phase 2: cross-session knowledge items)
```

`<session-basename>` is derived from the pi session JSONL filename
(`ctx.sessionManager.getSessionFile()`); for ad-hoc sessions it is `ad-hoc`.

---

## `status.json` schema

```jsonc
{
  "phase": "INERT | RESEARCHING | PLAN_DRAFTING | REVIEW_PENDING | EXECUTING",
  "approval": "none | pending | approved | rejected",
  "reason": "optional — present when approval is \"rejected\"",
  "done": 0,        // completed step count
  "total": 0,       // total step count
  "updatedAt": "2026-07-10T12:00:00.000Z"
}
```

## `active.json` schema

```jsonc
{
  "artifactDir": "<absolute path to the active session's artifact directory>",
  "phase":        "...",   // mirrors status.json
  "approval":     "...",   // mirrors status.json
  "done": 0, "total": 0,
  "updatedAt": "..."
}
```

`active.json` is the recommended single watch target: it tells a host *which*
session dir is live, so the host doesn't have to glob. It is overwritten on
every phase transition and on session resume.

---

## Host responsibilities (all optional-to-the-workflow, all fail-open)

### Display phase / progress
Watch `<cwd>/.pi/context-optimizer/active.json` (or glob `*/status.json`).
Render `phase`, `done`/`total`, and `approval`. Open `plan.md` / `tasks.md` /
`walkthrough.md` from `artifactDir` however the host likes.

### Approve / Reject a plan
When the user clicks "Approve" in your host, write the **active session's**
`status.json` with:

```json
{ "approval": "approved" }
```

or to reject (with an optional reason that the agent receives):

```json
{ "approval": "rejected", "reason": "step 3 is risky — split it" }
```

Merge with the existing fields (preserve `phase`, `done`, `total`) or write the
full object. The extension's `fs.watch` debounces and reconciles within ~120 ms.
You can find the active `artifactDir` by reading `active.json`.

> That's it. No HTTP, no auth token, no process spawn. The file write is the
> approval.

### Open files
Optional. Open `<artifactDir>/plan.md` etc. using your host's native editor
API. The extension also tries to open files itself (best-effort, see below) but
that is purely cosmetic — the files are on disk regardless.

---

## Minimal integration recipe (PiLot Studio or any host)

1. On startup, watch `<workspace>/.pi/context-optimizer/active.json`.
2. When it appears/changes, read it → get `artifactDir`, `phase`, `approval`.
3. Render a plan-review panel when `phase === "REVIEW_PENDING"`:
   - Show `<artifactDir>/plan.md`.
   - "Approve" button → write `<artifactDir>/status.json` with `approval:"approved"`.
   - "Reject" button → write `approval:"rejected"` (+ optional `reason`).
4. While `phase === "EXECUTING"`, show `<artifactDir>/tasks.md` (live checklist).
5. When `phase === "INERT"` again, show `<artifactDir>/walkthrough.md`.

No dependency on this package's HTTP surface is required.

---

## Optional HTTP bridge (cosmetic enhancement)

If a host *wants* the extension to proactively open files in its editor and push
status over HTTP, it can expose a tiny `/rpc` endpoint and set environment
variables before launching pi. The extension auto-detects it:

| Env var | Purpose |
|---------|---------|
| `PI_CO_BRIDGE_URL` | Base URL of the host's `/rpc` endpoint (generic convention) |
| `PI_CO_BRIDGE_TOKEN` | Auth token sent on the configured header |
| `PI_CO_BRIDGE_AUTH_HEADER` | Header name (default `x-pi-bridge-authorization`) |
| `PI_VSCODE_BRIDGE_URL` | Legacy: base URL (original pi-vscode convention) |
| `PI_VSCODE_BRIDGE_TOKEN` | Legacy: token (sent on `x-pi-vscode-authorization`) |

The generic convention (`PI_CO_BRIDGE_*`) is preferred when both are set. The
bridge calls two methods, both best-effort and never fatal:

- `openFile`  — `{ method: "openFile",  params: { filePath, preview } }`
- `setPlanStatus` — `{ method: "setPlanStatus", params: { state, approval, done, total } }`

If the bridge is unreachable or no env vars are set, the extension silently
falls back to spawning the `code` CLI, and if that is missing too, it does
nothing — the files are already on disk. **The workflow never depends on this
bridge succeeding.**
