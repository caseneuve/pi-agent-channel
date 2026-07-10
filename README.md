# agent-channel — inter-agent communication for pi

A pi extension that lets independently launched agents communicate
through named channels, with non-blocking polling and cmux sidebar
integration.

## Install

This is a package for [Pi](https://pi.dev/), the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
It supplies one extension (`extensions/agent-channel/index.ts`) and the bundled
`agent-comms` skill (`skills/agent-comms`).

Install a local checkout during development:

```bash
pi install ~/git/pi/pi-agent-channel
```

Install a reviewed immutable release tag in normal use:

```bash
pi install git:github.com/caseneuve/pi-agent-channel@v2026.7.10
```

Exact commit SHAs are also supported when maximum pinning precision is needed.

Pi filters package resources through its `packages` settings object. For example,
to load only the extension and not the skill:

```json
{
  "packages": [{
    "source": "git:github.com/caseneuve/pi-agent-channel@v2026.7.10",
    "extensions": ["extensions/agent-channel/index.ts"],
    "skills": []
  }]
}
```

Omit a filter key to load all resources from the package manifest. Use `pi config`
(or `pi config -l` for project-local settings) to enable or disable individual
resources.

### Relay lifecycle

The extension automatically falls back to file transport when no relay is
reachable. The detached UDS and HTTP relay remains Bun-backed.

For this MVP, the relay CLI requires a retained local checkout at a conventional
path without spaces or shell metacharacters. Git-only package users can use file
transport without installing the relay. Portable npm installation is tracked in
`todos/0001-publish-relay-cli-to-npm.md`.

Install the local checkout's package-owned control CLI explicitly; Pi package
installation never writes to `PATH`:

```bash
cd ~/git/pi/pi-agent-channel
bun run install-relay-cli
```

This installs `~/.local/bin/pi-agent-channel-relay`. Ensure `~/.local/bin` is
on `PATH`, then control the relay from any directory:

```bash
pi-agent-channel-relay --help
pi-agent-channel-relay start
pi-agent-channel-relay status
pi-agent-channel-relay restart
pi-agent-channel-relay logs
pi-agent-channel-relay stop
```

Remove the launcher explicitly when no longer wanted:

```bash
bun run uninstall-relay-cli
```

The installer refuses to replace or remove a different existing launcher unless
installation is rerun with `bun run install-relay-cli -- --force`. The relay
preserves the established socket (`/tmp/agent-channels.sock`), log
(`/tmp/agent-relay.log`), and `RELAY_HTTP_HOST`/`RELAY_HTTP_PORT` behavior.

### Development

```bash
bun install
bun test
bun run check
bun run format:check
```

## How it works

```
┌─────────────────┐                          ┌─────────────────┐
│  Agent A (pi)   │                          │  Agent B (pi)   │
│                 │   channel_send ──────►   │                 │
│  channel_watch  │◄──── ~/.agent-channels/  │  channel_send   │
│  (polls every   │      project_review.json │                 │
│   3 seconds)    │                          │  channel_status │
│                 │   channel_read ──────►   │  (sidebar 🔍)   │
│  channel_ack    │   channel_ack            │                 │
└────────┬────────┘                          └────────┬────────┘
         │                                            │
         │         cmux sidebar                       │
         │  ┌──────────────────────────┐              │
         └──│  Agent A: reviewing 🔍   │──────────────┘
            │  Agent B: done ✅        │
            │  ▓▓▓▓▓░░░ 60% building  │
            │  [info] found 3 issues   │
            └──────────────────────────┘
```

**Messages** are JSON files in `~/.agent-channels/`. Any number of pi
instances can read/write them. Each message has an `id`, `channel`,
`from`, `to`, `type`, `body`, and `acked` flag.

**Backends** are pluggable. The extension auto-detects cmux (for sidebar
status/progress/logs/notifications). Falls back to a file-only backend
with macOS `osascript` notifications.

## Tools

| Tool | Purpose |
|------|---------|
| `channel_send` | Send a message to a channel |
| `channel_read` | Read (poll) messages from a channel |
| `channel_ack` | Mark a message as received |
| `channel_watch` | Start background polling (auto-injects incoming messages) |
| `channel_unwatch` | Stop background polling |
| `channel_status` | Update local human-visible status surface (cmux sidebar, or tmux pane status/title) |
| `channel_list` | List all channels and message counts |

## Commands

| Command | Purpose |
|---------|---------|
| `/comms [on\|off]` | Toggle agent comms on/off |
| `/transport [file\|uds\|http <url\|host:port\|:port\|port>\|auto]` | Switch channel transport backend |
| `/channel-clear <name>` | Delete all messages from a channel |
| `/channel-ls` | List channels in the notification bar |

## Keyboard Shortcuts

| Shortcut | Purpose |
|----------|---------|
| `Alt+M` | Toggle agent comms on/off |

## Scenario: Code Review Loop

### Setup

Open two cmux workspaces, each running pi:

**Workspace "Agent-A":**
```
CMUX_AGENT_NAME=agent-a pi
```

**Workspace "Agent-B":**
```
CMUX_AGENT_NAME=agent-b pi
```

### Agent A (the coder)

Tell Agent A:
```
Watch channel "myproject/review" for incoming code reviews.
Continue working on the auth module while you wait.
When a review arrives, ack it, read the feedback, apply fixes,
then send a "fixes-applied" message back on the same channel.
```

Agent A will call `channel_watch("myproject/review")` and continue
working. When Agent B's review arrives, it gets injected into the
conversation automatically.

### Agent B (the reviewer)

Tell Agent B:
```
Review the code in src/auth.ts. When done, send the review on
channel "myproject/review" with type "code-review". Set your
sidebar status while working. Then watch for a "fixes-applied"
reply.
```

Agent B will:
1. `channel_status(status="reviewing auth.ts", icon="🔍")`
2. Read the code, write the review
3. `channel_send(channel="myproject/review", type="code-review", body="...")`
4. `channel_watch("myproject/review")` — waits for Agent A's reply
5. When Agent A sends "fixes-applied", the loop continues

### What the human sees

The cmux sidebar shows:
- **Agent-A**: `reviewing 🔍` → `applying fixes ⚙️` → `done ✅`
- **Agent-B**: `reviewing code 🔍` → `waiting for fixes ⏳` → `done ✅`
- Progress bars, log lines, and notification badges update in real time
- ⌘⇧U jumps to the latest notification from either agent

## Channel naming conventions

Use descriptive, scoped names:
- `project-name/code-review`
- `project-name/task-status`
- `worktree-branch/scout-report`
- `global/build-results`

## Environment variables

| Variable | Purpose |
|----------|---------|
| `CMUX_AGENT_NAME` | Agent identity for message `from` field |
| `PI_SESSION_NAME` | Fallback identity |
| `CMUX_SOCKET_PATH` | Auto-detected; triggers cmux backend |
| `TMUX` | Auto-detected; triggers tmux backend when cmux is not available |
| `AGENT_NOTIFY_MODE` | Notification strategy for tmux backend: `auto`, `tmux`, or `notify-send` |
| `AGENT_RELAY_URL` | HTTP relay URL for `HttpTransport` (if host is `0.0.0.0`, client normalizes to `127.0.0.1`) |

## Architecture: pluggable backends

The `ChannelBackend` interface is minimal:

```typescript
interface ChannelBackend {
  name: string;
  publish(msg: ChannelMessage): Promise<void>;
  read(channel: string, opts?): Promise<ChannelMessage[]>;
  ack(channel: string, messageId: string): Promise<void>;
  setStatus(key: string, value: string, icon?: string): Promise<void>;
  setProgress(fraction: number, label: string): Promise<void>;
  clearProgress(): Promise<void>;
  log(message: string, level?: string, source?: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}
```

Current backends:
- **CmuxBackend** — file-based messages + `cmux` CLI for sidebar/notifications (macOS)
- **TmuxBackend** — file-based messages + tmux pane titles, user options, and `display-message` for status/notifications (Linux / cross-platform). Supports `notify-send` with dunst stack tags for in-place progress updates.
- **FileOnlyBackend** — file-based messages + platform-native notifications (`osascript` on macOS, `notify-send` on Linux). No status bar integration.

Backend selection is automatic:
1. UDS relay reachable (`AGENT_UDS_SOCKET` or `/tmp/agent-channels.sock`) → `UdsTransport`
2. HTTP relay reachable (`AGENT_RELAY_URL`) → `HttpTransport`
3. Otherwise → `FileTransport`

When comms are turned ON, the extension injects a non-triggering
conversation message showing:
- active transport (`file`, `uds`, or `http`)
- currently reachable relays (`uds (...)`, `http (...)`, or `none`)

This notice is only emitted on comms ON transitions (or session start when
comms are already ON), and never when comms are OFF.

In **tmux mode**, subject/status intent is pane-local by design: `channel_status` updates this pane's status/title surface and does **not** act like shared channel-description metadata.

Set `AGENT_NOTIFY_MODE` to override TmuxBackend notification strategy:
- `tmux` — always use `tmux display-message` (default when `notify-send` not found)
- `notify-send` — always use `notify-send` (best with dunst for progress bars)
- `auto` — detect `notify-send` availability at startup (default)

Future backends could add:
- **RemoteBackend** — HTTP/WebSocket for cross-machine agents
- **RedisBackend** — for high-throughput multi-agent systems

## Known limitations

### File write race condition

Channel file I/O uses read-mutate-write which is not atomic. Concurrent
writes from multiple agents can race. This is acceptable for local dev —
channel files are append-mostly and the worst case is a lost message, not
corruption. A future improvement could use file locking or append-only
logs.

### Channel file pruning

Messages accumulate in channel files forever. For long-running sessions
with high message volume, files may grow large. Current mitigation:

- Use `/channel-clear <channel>` to manually clear a channel
- Start new task channels per task (they’re small and short-lived)

A future `/channel-prune` command or automatic TTL-based cleanup could
be added if this becomes a practical problem.

## Observability

Each `channel_send` emits one structured telemetry line via the sidebar
log source `channel-telemetry`:

```
send channel=<channel> from=<agent> type=<message-type> suffix=<OVER|OUT|none>
```

The format is intentionally stable `key=value` so grep / awk pipelines
keep working. This is the raw material for future stall analysis:

- a burst of `suffix=OUT` on a channel that then goes silent is usually
  an OUT-misuse that slipped past the send-time heuristic
- a `send` followed by a quick `channel_unwatch` on the same channel
  is a pre-reply unwatch
- long gaps with no `send` on a watched channel are genuine dead-air

Do not remove this line as "redundant" — the short `sent [...]` status
log it replaced carried the same information less consistently.

## Handling malformed frames

The extension never crashes on bad input; instead it **drops the bad
frame and tells the agent what happened**:

- A channel file with broken JSON or the wrong top-level shape returns an
  empty message list and logs the reason on stderr. The next `publish`
  overwrites the file, so recovery is automatic.
- Individual malformed messages inside an otherwise valid channel file
  are filtered out with a `dropped N malformed message(s)` warning.
- UDS frames are reassembled with a bracket-aware splitter that tolerates
  both newline-separated and glued (`}{`) frames and that carries
  partial frames across chunk boundaries.
- Whenever a transport has to drop a frame, it invokes its
  `onParseError` hook. The extension wires this hook to `pi.sendMessage`
  (non-triggering) so the agent sees a short diagnostic with a 500-char
  preview of the offending payload, and to the sidebar log for the
  human.
