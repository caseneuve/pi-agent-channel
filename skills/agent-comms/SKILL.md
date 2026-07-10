---
name: agent-comms
description: Communicate with other agents using shared channels, with backend-aware status and notifications (cmux, tmux, or file-only).
---

# agent-comms

Agents communicate through named channels. Two separate subsystems
handle this — keep them distinct in your mental model:

**Transport** (how message bytes move between agents):
- **UDS relay** at `/tmp/agent-channels.sock` — push delivery through a
  local Unix socket; used when the relay process is running (default
  for most sessions).
- **HTTP/SSE relay** at `$AGENT_RELAY_URL` — push delivery for
  cross-machine agents.
- **File fallback** at `~/.agent-channels/*.json` — polling; used when
  no relay is reachable. Always works as a last resort.

The extension picks one at session start via a transport probe. The
protocol (OVER/OUT, ack-first, presence, channel names) is identical
across all three; which one is live is transparent to the agent.

**Display** (how local UI renders status, progress, notifications):
- **cmux** — sidebar pills, progress bars, notification badges.
- **tmux** — pane titles, user options, `display-message` or `notify-send`.
- **file-only** — no sidebar; notifications via `osascript` / `notify-send`.

Transport and display are chosen independently. A cmux session can run
on any transport; a bare terminal can still use the UDS relay if one
is running. Only `channel_status` output differs across displays
(it's sidebar-bound); `channel_send` / `channel_read` / `channel_watch`
do not.

See "Display backends" below for display-specific setup.

## Common mistakes (read first)

These are the real failure modes we see in production. Do not repeat them.

### 1. OUT means "BOTH sides confirmed done" — not "I'm done"

The single most important rule. Read twice.

- **OVER** (or no suffix) — default. Your turn is done, the other agent
  should reply. Use this for almost every message.
- **OUT** — the conversation is over. The receiver's turn is suppressed
  (`shouldTriggerTurn` returns false), so they will NOT be woken up.

**"Conversation is done" means both sides have confirmed completion.**
One side saying "I think we're done" is not enough. The exchange closes
only after a two-step handshake:

1. Peer sends a definitive closer (`approved`, `task-complete`, etc.) —
   typically with OVER so you can confirm.
2. You reply with a short acknowledgement + OUT (e.g. `ack. OUT` or
   `thanks, confirmed. OUT`).

Only in step 2 is OUT correct. **If you are the first to say "done",
use OVER so the peer can confirm.** If in doubt, use OVER — worst case
the peer answers with a quick ack; using OUT prematurely silently kills
the channel.

If you end a message with OUT and you were actually expecting a reply,
the receiver sees the message but is never prompted to act on it. The
channel then goes dead.

The `channel_send` tool returns an OUT-misuse warning when your body
ends with OUT but contains `?`, `please`, `can you`, `review this`,
`let me know`, `your turn`, `waiting for`, etc. If you see that
warning, resend the message ending with OVER.

Legitimate OUT uses — **only after peer already said they were done**:
- `ack. OUT` after a peer `approved`
- `thanks, confirmed. OUT` after a peer `task-complete`
- final `pong` after a `ping`/`pong` round where both have spoken

Illegitimate OUT — every other case, including:
- Delivering a summary of work you did (use OVER, wait for review)
- A “summary followup” continuing an existing review/work loop where
  you expect the peer to respond (use OVER — this is the exact class
  of mistake round-5 surfaced in production)
- “Status update” style messages (use OVER or no suffix)
- First message on a new task channel (use OVER or no suffix)
- Replying to an open `review-request` (use OVER)

### 2. Do not `channel_unwatch` while a reply is still owed

`channel_unwatch` turns off push delivery for that channel. Any message
the other agent publishes after you unwatch will not reach your
conversation until you watch the channel again.

Only unwatch after BOTH sides have confirmed completion (peer sent
`approved` or `task-complete`, you acked with OUT). When in doubt,
leave it watched — watches are cheap.

If you realize you unwatched too early, call
`channel_watch(channel, catch_up=true)` to replay missed messages.

### 3. `channel_status` is NOT a message to the other agent

`channel_status` updates the human-facing sidebar only. Other agents do
not see it. If agent A sets `channel_status("reviewing")` and then
waits, agent B has no way to know A is working — B will sit there
silently until it times out.

Rule of thumb:
- Need the human to know? → `channel_status`.
- Need another agent to know / react? → `channel_send`.
- Need both? → call both.

### 4. Trust the orientation message

On session start the extension injects an orientation note telling you
your agent name and your lobby channel. You do not need to guess either.
Do not re-announce presence manually on the lobby — it happens
automatically.

## Setup — automatic

The extension handles setup automatically:
- The lobby channel is **auto-watched** on session start — you don't need to call `channel_watch` for it.
- Your **agent name** and **lobby channel** are delivered in an orientation message at session start (before the first incoming channel message).
- A **presence announcement** is automatically sent when you auto-watch the lobby and when you call `channel_watch` on any other channel.

You're ready to communicate as soon as the orientation message arrives.

## Lobby vs task channels

The **lobby** (`CMUX_WORKSPACE_ID` or tmux-derived lobby) is for coordination:
- Announcing what you're working on
- Telling others where to find your results
- Short status updates

For longer workflows (code review, multi-step tasks), **create a task channel**
with a descriptive name and announce it on the lobby:

```
channel_send(
  channel: <CMUX_WORKSPACE_ID>,
  type: "status",
  body: "Starting code review for ticket 0042. Sending results on channel: agentic-stuff/review-0042"
)
channel_watch(channel: "agentic-stuff/review-0042")
```

The other agent sees this on the lobby, starts watching the task channel.

### Channel naming convention

Task channels **must** be scoped to the specific task, not shared across tasks:

```
<project>/review-<ticket>      ← code review for a ticket
<project>/deploy-<ticket>      ← deployment coordination
<project>/retro-<date>         ← retrospective discussion
```

**Do not** reuse generic names like `<project>/review` — concurrent tasks will
collide. Once a task is mutually closed (both sides OUT per §1 above), the
channel is dead. New task = new channel.

Follow-up work **must** be announced on the lobby first — the other agent is no
longer watching the old task channel after mutual close. Never send to a
closed channel; create a new one and announce it on the lobby so the other
agent knows to watch it.

## Acting on messages — ack-first protocol

When a message arrives that expects a follow-up, **acknowledge
immediately before doing the work**. Silence between receiving a
request and sending results makes the sender think their message got
dropped or you stalled. The channel should show continuous motion.

Standard three-step loop for any request-shaped message:

**Review-channel guardrail:** for code review, call `channel_watch(review-channel, catch_up=true)` before (or immediately with) the first `review-request`, then keep watching and actively respond until approval/close. Do not go idle while review is unresolved; if blocked, escalate to human per timeout rules.

1. **ACK** — send a short acknowledgement the moment you receive the
   request, before doing any work. Use `type: "ack"` or `type:
   "status"`, name the task, sign with OVER.

   ```
   channel_send(
     channel: "agentic-stuff/review-0042",
     type: "ack",
     body: "got the review request, starting now. Will send findings shortly. OVER"
   )
   ```

2. **DO THE WORK** — run the review / fix the bug / read the files /
   whatever was asked. This is the only step that's allowed to take
   time without the peer seeing anything.

3. **REPLY WITH RESULTS** — send the real answer with the appropriate
   type (`review-response`, `task-complete`, `pong`, etc.), sign with
   OVER so the peer can confirm.

   ```
   channel_send(
     channel: "agentic-stuff/review-0042",
     type: "review-response",
     body: "3 issues found: ...\nFull review at .reviews/2026-04-25.md. OVER"
   )
   ```

4. **PEER CONFIRMS** — peer replies with `approved` / `task-complete` /
   next request (OVER). If they close with `approved` you reply with a
   short `ack. OUT` per §1 above. Otherwise the loop continues.

When an ack is NOT needed (message does not expect follow-up):
- `presence` — informational only.
- `status` updates from the peer that are just FYI.
- `ack` — don't ack an ack (infinite regress). The runtime also
  suppresses the turn for `type: "ack"`, so acks arrive as context.
- Any message that ended with OUT — the peer explicitly doesn't want a
  reply, and `shouldTriggerTurn` has already suppressed your turn
  anyway.

### When to skip the ack step (fast path)

If the follow-up work takes less than a turn to complete — e.g. a
sub-second verification, a trivial lookup, a one-line fix — you can
skip the ack and go straight to the result with OVER. The ack exists
to cover the observability gap while work is in flight; if there is no
gap, the ack is just noise.

Rule of thumb: if you'd finish before the peer has time to read the
ack, skip it. Otherwise ack first.

### Why the ack matters

- The sender learns their message landed. No silent-dropped-message
  guessing.
- The sender can set `channel_status("waiting for findings from
  reviewer")` and move on to other work.
- If something goes wrong mid-work the ack is already on the channel,
  so a human investigator sees the receiver *was* engaged and can pin
  down where the stall happened.
- Works even when your work takes 10 minutes — the channel shows
  step-by-step progress instead of a 10-minute void.

### Examples by incoming type

- `ping` arrives → immediate `pong` with OVER (the ack IS the result).
- `request` arrives → ack ("on it"), do it, send result with OVER.
- `review-request` arrives → ack ("reviewing now"), run review, send
  `review-response` with OVER.
- `review-response` arrives → ack ("applying fixes"), apply fixes, send
  `task-complete` with OVER.
- `task-complete` arrives → ack ("verifying"), verify, reply `approved`
  with OVER.
- `approved` arrives → reply `ack. OUT` (the mutual-close from §1).

Messages received via `channel_watch` are **auto-acknowledged** at the
transport level (internal bookkeeping). That's separate from the
conversational ack described here — you still need to `channel_send`
an ack message so the *peer* knows you got it.

For messages read via `channel_read` (manual polling), also call
`channel_ack` after processing to clear the unacked queue:

```
channel_ack(channel: "...", message_id: "...")
```

## Code review workflow example

**Reviewer agent:**
1. Watches lobby → sees "review my changes on `myproject/review-0042`".
2. Watches `myproject/review-0042`.
3. Receives `review-request` with diff summary.
4. **Immediately acks** on `myproject/review-0042`:
   `type: "ack", body: "got it, reviewing now. OVER"`.
5. Runs review, writes review file.
6. Sends `review-response` with review file path and summary (OVER).
7. Waits for fixes.

**Dev agent:**
1. Announces on lobby: "Sending review request on `myproject/review-0042`".
2. Sends `review-request` on `myproject/review-0042` (OVER).
3. Watches `myproject/review-0042` for response.
4. Sees reviewer's `ack` — notes that review is in progress, can update
   own `channel_status` to "waiting for reviewer" and continue on
   other work.
5. Receives `review-response` — acks with
   `type: "ack", body: "reading review, starting fixes. OVER"`, then
   applies fixes.
6. Sends `task-complete` with summary of what was fixed (OVER).
7. Reviewer acks, verifies, sends `approved` (OVER) or another
   `review-response` (OVER).
8. If `approved`: dev replies `ack. OUT`. Channel is now mutually
   closed.

## Message type conventions

| type | meaning | expected reaction |
|------|---------|-------------------|
| `ping` | Are you there? | Reply with `pong` (use OVER) |
| `pong` | I'm here | Acknowledge (use OVER unless closing a mutual-handshake exchange) |
| `presence` | Agent joined channel | Note it (auto-sent by `channel_watch`) |
| `status` | Progress update / announcement | Note it, act if relevant |
| `request` | Do this task | Do it, send result with OVER |
| `task-complete` | Work is done | Verify; reply with `approved` (OVER) or another `review-response` (OVER). The sender of `task-complete` must use OVER, not OUT. |
| `review-request` | Please review these changes | Review and send findings with OVER |
| `review-response` | Here are review findings | Fix issues, send `task-complete` with OVER |
| `approved` | Looks good | Reply with a short `ack. OUT`. This is the only place OUT is normally correct. |
| `ack` | Receipt confirmation or final closer. Delivered as context only (`shouldTriggerTurn` returns false for `type: "ack"` regardless of suffix). | Mid-loop ack: note and continue. Final closer (`ack. OUT` after `approved`): ends the exchange. |

## Sending

End your message with **OVER** or **OUT** to control turn-taking. Read
§1 “Common mistakes” above before relying on OUT.

- **OVER** — the default. Your turn is done, the other agent should
  reply. Use for almost every message, including ones where you think
  you're wrapping up.
- **OUT** — the conversation is closed by mutual agreement. Only
  correct when the peer has already confirmed they are done (e.g. they
  sent `approved` or `task-complete`) and you are replying with a short
  acknowledgement. Being the first to say OUT silently kills the
  channel.
- No suffix — same as OVER (other agent acts).

OUT suppresses the receiver's turn — misusing it is the number-one
reason agent conversations silently stall.

### Examples

Keep the loop open — the normal case:

```
channel_send(
  channel: "<channel-name>",
  type: "<message-type>",
  body: "Here are the review findings. OVER"
)
```

Close the loop — only after the peer already confirmed completion:

```
# peer just sent: { type: "approved", body: "All fixes verified. OVER" }
channel_send(
  channel: "<channel-name>",
  type: "ack",
  body: "thanks, confirmed. OUT"
)
```

The first “done” message in an exchange uses OVER, not OUT:

```
# WRONG — silently kills the channel
channel_send(
  channel: "<channel-name>",
  type: "task-complete",
  body: "All fixes applied, PR pushed. OUT"
)

# RIGHT — peer gets a turn to confirm
channel_send(
  channel: "<channel-name>",
  type: "task-complete",
  body: "All fixes applied, PR pushed. OVER"
)
```

`channel_send` returns an OUT-misuse warning when it detects request-like
phrasing paired with OUT or a reply-expecting message type (`request`,
`review-request`, `ping`, etc.). If you see that warning, resend the
message ending with OVER.

## Receiving

Messages from watched channels are injected into your conversation automatically
and **auto-acknowledged**. When one arrives:
1. Act on it — do the work described
2. Respond on the same channel with results

**Note:** `channel_watch` only picks up messages sent *after* the watch starts.
To catch up on messages you might have missed, use the `catch_up` flag:

```
channel_watch(channel: <lobby>, catch_up: true)
```

This replays all unacked messages, injects them into your conversation, acks them,
then starts polling for new ones — all in a single call.

## Joining late

If you start after other agents are already communicating:

1. `channel_list` — discover what channels exist
2. `channel_watch(channel: ..., catch_up: true)` on the lobby and relevant task channels
3. Announce yourself on the lobby

The `catch_up` flag handles read + ack + watch in one step.

## Acknowledging messages

Messages received via `channel_watch` are auto-acked. For `channel_read`, use
`channel_ack` with three modes:

| `message_id` | effect |
|--------------|--------|
| `"<id>"` | Ack a specific message by ID |
| `"last"` | Ack the most recent unacked message on the channel |
| `"*"` | Ack **all** unacked messages on the channel |

Use `"*"` to bulk-clear a channel after catching up.
Use `"last"` when you only care about the latest message.

## Other useful tools

- `channel_list` — see all channels and their message counts.
- `channel_status` — update the sidebar status/progress visible to the **human only**. Does NOT send anything on any channel. If another agent needs to know your state, use `channel_send`.
- `channel_unwatch` — stop receiving messages on a channel. Only use when the exchange is fully done; otherwise replies will be silently lost.
- `/agent-name <label>` — set your display name (e.g. `/agent-name reviewer` → `agent-reviewer`). The extension injects a note into your conversation confirming the new name.

## Multi-step work

When you have multiple sequential tasks for the same collaborator:

1. **Announce the plan on the lobby** at the start: "Working on N batches.
   Will send review requests sequentially on `<project>/review-<ticket>` channels."
2. **Between steps**, send a heads-up on the lobby before closing the current
   task channel: "Batch 1 done. Batch 2 coming next. Standby. OVER"
3. The collaborating agent **stays on the lobby** until all announced work is
   complete.

This prevents the other agent from going idle between steps. Mutual OUT
on a task channel means that channel is done — not that all work is
done. The lobby is where continuity lives.

## Timeouts and escalation

When waiting for a response on a task channel:

- **2 minutes, no response** — re-ping the lobby: "Still waiting for reviewer on `<channel>`. Anyone available?"
- **5 minutes, no response** — notify the human: use `channel_status` with a warning log
- **Do not** block silently — always escalate if a task channel goes quiet

This prevents dead-air situations where both sides assume the other is working.

## Review request format

When sending a `review-request`, include enough context for the reviewer to work
independently. Use this structure:

```
## What changed
<Brief summary of the change — what and why>

## Files
<List of changed files with one-line description each>

## How to review
<Exact command to see the diff, e.g. `cd /path && git diff HEAD~1`>

## Tests
<Test results: pass count, failure count, how to re-run>

## Risk
<What could go wrong, edge cases, migration concerns>
```

This avoids the reviewer guessing what to look at or how to verify.

## Display backends

These control local UI only (status pills, progress, notifications).
They do NOT affect which transport is used or how messages move — see
the intro for that.

### cmux (macOS)

Full sidebar support: status pills, progress bar, log lines, notification badges.
Detected automatically when `CMUX_SOCKET_PATH` is set or `cmux` is on PATH.

### tmux (Linux / cross-platform)

Status is shown via tmux pane titles and pane user options.
Notifications use `tmux display-message` by default.

In tmux: channel messages/status are for agent-to-agent coordination; pane title/status is for the human observer's local context.

For richer notifications, set `AGENT_NOTIFY_MODE=notify-send` to use
`notify-send`. With dunst, progress bars update in-place via stack tags.

To show agent status in the tmux status bar, add to `tmux.conf`:

```tmux
set -g pane-border-format "#{pane_title}"
set -g pane-border-status top
```

### file-only (display fallback)

Status and progress are no-ops (no sidebar or pane titles to render to).
Notifications fall back to `osascript` on macOS or `notify-send` on Linux.

This does NOT imply the file transport is in use — transport selection is
independent. If no relay is running, `FileTransport` polls
`~/.agent-channels/*.json`; if a relay is running, the agent uses UDS
or HTTP regardless of whether cmux/tmux is available.

On this display fallback, the default lobby channel is `file/lobby` —
a machine-global channel shared by all pi agents running in bare
terminals, so agents on the same machine auto-discover each other
without configuration. Use dedicated task channels for isolation.
