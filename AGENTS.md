# AGENTS.md — Pi package development

This repository contains a public Pi package for [pi-coding-agent](https://pi.dev/). Before changing code, read the relevant upstream Pi source and documentation in the installed `@earendil-works/pi-coding-agent` package (especially package, extension, settings, and UI APIs). Treat the supported Pi API and its conventions as the compatibility contract.

## Development procedure

1. Discuss the problem and agree on scope.
2. Create or update a todo with concrete acceptance criteria. Record important design decisions and departures from the original plan in that todo so it remains the durable decision record.
3. Create a task branch; keep `master` stable.
4. Develop with checkpoint commits. Prefer red → green → refactor when testable.
5. Run tests, formatting, linting, and installation checks.
6. Request peer review against the todo and this file.
7. Address findings in new commits, then squash and merge only after approval.

The merge commit should reference its todo when one exists. Checkpoint commits should identify the iteration step (red, green, refactor, and so on) and briefly describe the work achieved. Do not redesign behavior or expand platform support without an explicit todo.

## Releases

This project uses npm-compatible CalVer. Package versions use `YYYY.M.D` without zero-padding, and annotated Git release tags use the matching `vYYYY.M.D` form (for example, package version `2026.7.10` and tag `v2026.7.10`). CalVer remains the project policy, but npm requires SemVer-compatible syntax and rejects leading zeroes in numeric components.

Release procedure:

1. Complete automated checks and the focused manual installation checklist.
2. Update `CHANGELOG.md` and set the release version in `package.json`.
3. Squash and merge the approved work.
4. Create and push an annotated `vYYYY.M.D` tag with the stable branch.
5. Verify Pi installation from that immutable release tag.

## Engineering discipline

- Prefer TDD. If automated testing is impractical for an extension, document and perform focused manual testing.
- Use FCIS: isolate pure planning/transformation/formatting from filesystem, process, and UI side effects; keep functions short and orchestration explicit.
- Design with precise TypeScript types.
- Apply KISS, DRY, and YAGNI; prefer modularity and straightforward extension points over cleverness.
- Preserve existing commands, tools, shortcuts, resource paths, settings, and platform limitations.
- Keep Pi API packages as peer dependencies and runtime libraries in installable dependencies.
- Let the configured `prek` hooks enforce TypeScript formatting and lint checks before commits.

## Review checklist

Reviewers must check:

- Conformance to the todo and acceptance criteria.
- Testability, coverage, and manual-test evidence where needed.
- Correct Pi manifest/resource paths and install behavior.
- Conformance to Pi source code, documented APIs, and project philosophy.
- FCIS, modularity, extensibility, KISS, DRY, and YAGNI discipline.
- Preservation of public behavior and documented platform limits.
- Formatting and linting are assumed to be enforced by `prek`; investigate any bypass or failure.
- For visible UI changes, require screenshot review unless a human explicitly waives it.

## Scope guardrails

Npm publication, generalized scaffolding, new APIs, unrelated refactors, daemon hardening, and feature improvements belong in separate todos.
