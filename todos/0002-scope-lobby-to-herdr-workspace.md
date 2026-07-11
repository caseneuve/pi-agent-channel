---
title: scope lobby to herdr workspace
status: open
priority: high
type: bug
labels: [NEXT_VER]
created: 2026-07-11
parent: null
blocked-by: []
blocks: []
---

## Context

When Pi runs inside Herdr, the extension ignores Herdr's workspace identity and falls through to the machine-global `file/lobby`. The smoke test on 2026-07-11 consequently reached agents in unrelated Herdr workspaces (`pi-agent-channel`, `pi-bad-actors`, and others), even though the lobby should coordinate only agents in the relevant Herdr space.

The observed environment exposes `HERDR_ENV=1`, `HERDR_WORKSPACE_ID=w7`, `HERDR_TAB_ID=w7:t1`, `HERDR_PANE_ID=w7:p1`, and `HERDR_SOCKET_PATH=...`. `herdr workspace list` also reports the focused workspace. Current lobby resolution only recognizes `CMUX_WORKSPACE_ID`, then tmux session+window, then falls back to `file/lobby`.

This task must first establish the correct cross-multiplexer scoping model. In particular, clarify whether “currently focused space” means the process-owning Herdr workspace identified by `HERDR_WORKSPACE_ID`, the dynamically focused workspace returned by the Herdr API, the current tab, or another stable scope. A lobby must not silently change underneath a long-running Pi process without explicit subscription migration semantics.

The agreed design direction is a small pluggable environment seam rather than adding more Herdr/cmux/tmux conditionals to `resolveLobbyFromEnv()`. Each environment provider should detect only its own runtime and return a normalized, stable lobby scope; orchestration selects the first applicable provider by explicit precedence. Display backends and message transports remain separate concerns.

## Acceptance Criteria

- [ ] Document the actual identity/focus semantics and lifecycle of `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and the focused flag returned by the Herdr API, including behavior when the human changes focus while Pi keeps running.
- [ ] Compare and document existing lobby scopes: cmux uses `CMUX_WORKSPACE_ID`; tmux uses socket+session+window; bare terminals use the machine-global `file/lobby` fallback.
- [ ] Decide the intended common abstraction (workspace, tab/window, pane, or dynamic focus) for Herdr, cmux, and tmux, recording any intentional backend-specific differences.
- [ ] Define a minimal typed environment-provider interface that can detect applicability and resolve a normalized stable lobby scope without knowing about transports or displays.
- [ ] Implement Herdr, cmux, tmux, and bare-terminal providers behind that interface, selected through an explicit ordered provider registry.
- [ ] Adding another multiplexer environment requires a new provider plus registration/tests, not edits to a central backend conditional.
- [ ] Add Herdr with explicit precedence relative to cmux and tmux; do not infer Herdr merely from the CLI being installed.
- [ ] Herdr Pi instances in the same intended space resolve the same stable lobby, while instances in different spaces resolve different lobbies.
- [ ] Lobby presence, auto-watch, comms on/off, reload, and restored watch state continue to operate on the resolved lobby without leaking announcements to unrelated spaces.
- [ ] Transport remains orthogonal: Herdr lobby scoping works over UDS, HTTP, and file transport and does not use `file/lobby` merely because the display backend is file-only.
- [ ] Pure resolver tests cover Herdr, cmux, tmux, mixed environment precedence, incomplete Herdr environment, and bare-terminal fallback.
- [ ] Focused manual tests with at least two Herdr workspaces confirm that a lobby ping is received only inside the selected scope.
- [ ] README and bundled `agent-comms` skill explain the resulting Herdr/cmux/tmux lobby scopes and the global bare-terminal fallback.

## Affected Files

- `extensions/agent-channel/lobby.ts` — normalized lobby scope types and pure provider selection.
- `extensions/agent-channel/environments/` (or an equivalently focused module) — Herdr, cmux, tmux, and fallback providers behind the shared seam.
- `extensions/agent-channel/index.ts` — dependency wiring and only, if required, explicit lobby subscription migration.
- `extensions/agent-channel/index.test.ts` — resolver and precedence coverage.
- `extensions/agent-channel/core.test.ts` — orientation/lifecycle coverage if behavior changes.
- `README.md` — supported multiplexer lobby semantics and environment variables.
- `skills/agent-comms/SKILL.md` — agent-facing lobby guidance.

## E2E Spec

GIVEN Pi agents running in two different Herdr workspaces over the same relay
WHEN an agent announces presence or sends a ping on its automatically resolved lobby
THEN agents in the same intended Herdr space receive it and agents in the other workspace do not.

GIVEN equivalent sessions in cmux and tmux
WHEN their lobby identifiers are resolved
THEN the documented workspace/window isolation remains unchanged unless this todo records and tests an intentional migration.

## Notes

- Observed defect: all Herdr agents resolved `file/lobby` because `resolveLobbyFromEnv()` has no Herdr branch.
- Current resolver priority is cmux workspace → tmux socket/session/window → `file/lobby`.
- Herdr environment observed during reproduction: `HERDR_WORKSPACE_ID=w7`, `HERDR_TAB_ID=w7:t1`, `HERDR_PANE_ID=w7:p1`.
- Prefer providers that transform injected environment/API facts into a normalized scope; keep socket/API calls at the orchestration boundary.
- Keep the seam KISS-sized. A likely shape is `detect(context)` plus `resolveLobby(context)` or a single `resolve(context): LobbyScope | undefined`; do not introduce a general multiplexer framework before another behavior needs it.
- Provider results should carry a stable backend-qualified identifier and enough diagnostic metadata for orientation/debugging without leaking backend-specific branching into callers.
- Provider precedence and fallback are policy owned by the registry, not hidden inside individual providers.
- Do not conflate lobby routing with Herdr status/notification display integration, which can be tracked separately if desired.
