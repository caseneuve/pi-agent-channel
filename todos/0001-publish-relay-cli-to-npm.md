---
title: publish relay cli to npm
status: open
priority: medium
type: chore
labels: [NEXT_VER]
created: 2026-07-11
parent: null
blocked-by: []
blocks: []
---

## Context

The MVP relay control CLI is installed from a retained local checkout and embeds that checkout's absolute path in `~/.local/bin/pi-agent-channel-relay`. This is sufficient for the initial single-user release but is not a portable installation experience for Git-only Pi package users. Publishing an npm-installable CLI is also an opportunity to establish the package's publication workflow and evaluate whether Bun remains the right long-term relay runtime.

Relay startup currently constructs an unquoted `sh -c` command. The MVP documents its conventional-path limitation rather than adding shell-quoting patches; portable packaging must replace shell interpolation with argument-safe process spawning.

## Acceptance Criteria

- [ ] Decide and document whether the Pi extension and relay CLI ship as one npm package or separate packages.
- [ ] Evaluate Bun versus native Node using implementation cost, runtime availability, package ergonomics, and transport compatibility; record the decision before changing runtime support.
- [ ] Add an explicit npm `files` allowlist containing every runtime resource and excluding development-only files.
- [ ] A packed artifact installs into an isolated npm prefix and exposes a working `pi-agent-channel-relay` executable.
- [ ] The installed CLI supports `--help`, `start`, `stop`, `status`, `restart`, and `logs` without depending on a source checkout or dotagents files.
- [ ] Relay startup passes executable arguments without constructing a shell command and works from installation paths containing spaces and shell metacharacters.
- [ ] Bun is documented as a runtime prerequisite if retained; a Node port has explicit compatibility tests and a minimum supported version if selected.
- [ ] Install, update, uninstall, release, and publication commands are documented and manually verified from the packed artifact.
- [ ] Existing extension and relay tests continue to pass.

## Affected Files

- `package.json` — publication metadata, files allowlist, binary, and release scripts.
- `bin/` and `scripts/` — portable relay CLI entrypoint and argument-safe lifecycle management.
- `relay/` — only if the recorded runtime decision selects a Node port.
- `README.md` and `AGENTS.md` — user installation and maintainer publication procedures.
- `CHANGELOG.md` — published release notes.
- CLI and packaging tests — isolated packed-artifact installation and lifecycle coverage.

## E2E Spec

GIVEN a clean environment with the documented runtime installed and no source checkout
WHEN the packed npm artifact is installed into an isolated prefix
THEN `pi-agent-channel-relay` is on that prefix's executable path and all documented lifecycle operations work without dotagents files.

## Notes

- Npm publication is intentionally separate from the initial extraction tracked in dotagents todo `0027.1`.
- Retain Bun for the first packaging iteration unless the runtime evaluation justifies expanding scope; converting `Bun.serve`, Bun process APIs, and the test runner is a runtime port rather than a mechanical packaging change.
- PID handling, stale-process recovery, service-manager integration, and unrelated daemon hardening remain outside this todo.
