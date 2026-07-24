# Changelog

## [2026.7.24] - 2026-07-24

### Fixed

- Register the bundled `agent-comms` skill through the standard Pi manifest discovery (`pi.skills: ["./skills"]`) and remove the hand-rolled `resources_discover` hook that pointed at a nonexistent `extensions/agent-channel/skills` path, resolving the skill-conflict error.

## [2026.7.10] - 2026-07-10

### Added

- Initial public release of the agent-channel Pi extension and bundled `agent-comms` skill.
- File, UDS, and HTTP message transports.
- cmux, tmux, and file-only display backends.
- Bun-backed detached relay and `pi-agent-channel-relay` lifecycle CLI.
- Explicit install and uninstall commands for the relay CLI launcher.
- Descriptive relay CLI help and invalid-command guidance.
