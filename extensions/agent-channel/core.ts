// ─── Pure core: zero I/O, fully testable ────────────────────────────────
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────
export interface ChannelMessage {
  id: string;
  channel: string;
  from: string;
  to?: string;
  type: string;
  body: string;
  timestamp: number;
  acked?: boolean;
}

export interface ChannelFile {
  messages: ChannelMessage[];
}

export interface FilterOpts {
  since?: number;
  unacked?: boolean;
  type?: string;
}

// ─── Pure functions ─────────────────────────────────────────────────────

/** Build the filesystem path for a channel name. Pure string→string. */
export function channelPath(channelDir: string, channel: string): string {
  const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(channelDir, `${safe}.json`);
}

/** Filter messages by since/unacked/type. Shared across all backends. */
export function filterMessages(
  msgs: ChannelMessage[],
  opts?: FilterOpts,
): ChannelMessage[] {
  let result = msgs;
  if (opts?.since) result = result.filter((m) => m.timestamp > opts.since!);
  if (opts?.unacked) result = result.filter((m) => !m.acked);
  if (opts?.type) result = result.filter((m) => m.type === opts.type);
  return result;
}

/**
 * Ack messages in a channel file. Returns a NEW ChannelFile — no mutation.
 * Supports three modes: "*" (all), "last" (most recent unacked), or specific id.
 */
export function ackMessages(
  file: ChannelFile,
  messageId: string,
): { file: ChannelFile; ackedCount: number } {
  const messages = file.messages.map((m) => ({ ...m }));
  let ackedCount = 0;

  if (messageId === "*") {
    for (const m of messages) {
      if (!m.acked) {
        m.acked = true;
        ackedCount++;
      }
    }
  } else if (messageId === "last") {
    const unacked = messages.filter((m) => !m.acked);
    const last = unacked[unacked.length - 1];
    if (last) {
      last.acked = true;
      ackedCount = 1;
    }
  } else {
    const msg = messages.find((m) => m.id === messageId);
    if (msg) {
      msg.acked = true;
      ackedCount = 1;
    }
  }

  return { file: { messages }, ackedCount };
}

/**
 * Determine whether an incoming message should trigger an agent turn.
 *
 * Suppressed (delivered as context only, receiver not woken up) for:
 *   - `type: "presence"` — agent joined channel; informational.
 *   - `type: "ack"` — peer acknowledges receipt of a prior message; the
 *     sender already knows what to do next, the ack just confirms
 *     delivery. Matches the ack-first protocol documented in the
 *     agent-comms skill.
 *   - bodies ending with the OUT sign-off — conversation is being
 *     mutually closed per §1 of the skill.
 *
 * Everything else (including `type: "status"`) triggers a turn.
 */
export function shouldTriggerTurn(msg: ChannelMessage): boolean {
  if (msg.type === "presence") return false;
  if (msg.type === "ack") return false;
  if (endsWithOut(msg.body)) return false;
  return true;
}

/** Does the trimmed body end with the OUT sign-off? */
export function endsWithOut(body: string): boolean {
  return /\bOUT$/i.test(body.trimEnd());
}

/** Does the trimmed body end with the OVER sign-off? */
export function endsWithOver(body: string): boolean {
  return /\bOVER$/i.test(body.trimEnd());
}

/**
 * Classify the turn-control suffix on an outgoing body. Used both for the
 * receiver-side turn decision and for send-side telemetry so one regex
 * pair is the single source of truth.
 *
 * Precedence: OUT wins over OVER when somehow both appear (e.g. "OVER OUT")
 * because `shouldTriggerTurn` checks OUT and returns false.
 */
export type TurnSuffix = "OVER" | "OUT" | "none";
export function classifySuffix(body: string): TurnSuffix {
  if (endsWithOut(body)) return "OUT";
  if (endsWithOver(body)) return "OVER";
  return "none";
}

/**
 * Heuristic: an outgoing message that ends with OUT but whose body is
 * phrased as a question / request. Surfacing these at send-time catches the
 * very common "agent meant OVER, typed OUT" mistake before the other side
 * silently drops the turn.
 *
 * Returns `null` when the body is fine (not OUT, or OUT + clearly closing),
 * otherwise a short human-readable reason.
 */
export function detectOutMisuse(
  body: string,
  messageType?: string,
): string | null {
  if (!endsWithOut(body)) return null;

  const type = messageType?.toLowerCase();

  // Messages that legitimately close a conversation — OUT is appropriate,
  // skip every further check.
  const closingTypes = new Set([
    "approved",
    "task-complete",
    "pong",
    "presence",
    "ack",
  ]);
  if (type && closingTypes.has(type)) return null;

  // Messages whose `type` itself encodes an expectation of reply. OUT is
  // almost certainly a mistake here regardless of body phrasing — this is
  // the positive complement of `closingTypes` and catches the implicit-ask
  // class the body-only heuristic missed (e.g. a review-request whose body
  // reads "diff attached. OUT" with no explicit question words).
  const replyExpectingTypes = new Set([
    "ping",
    "request",
    "review-request",
    "review-followup",
    "code-review",
    "question",
  ]);
  if (type && replyExpectingTypes.has(type)) {
    return `type "${messageType}" expects a reply — use OVER instead of OUT`;
  }

  const stripped = body
    .trimEnd()
    .replace(/\bOUT$/i, "")
    .trim();
  if (!stripped) return null;

  // Direct question mark anywhere in the body — agent almost certainly wants
  // a reply.
  if (/\?/.test(stripped)) {
    return "body contains a question mark — use OVER if you expect a reply";
  }

  // Common request / reply-expecting phrasings.
  const requestPatterns: Array<[RegExp, string]> = [
    [/\b(please|pls)\b/i, '"please" suggests a request'],
    [
      /\b(can|could|would|will)\s+you\b/i,
      "phrased as a request to the other agent",
    ],
    [/\b(let me know|lmk)\b/i, "asks the other agent to respond"],
    [
      /\b(waiting for|standby for|ready for)\b/i,
      "signals you are waiting for a reply",
    ],
    [
      /\b(review|check|verify|confirm)\s+(this|that|my|the)\b/i,
      "asks the other agent to act",
    ],
    [
      /\b(your turn|over to you|back to you)\b/i,
      "explicit turn-handoff — use OVER",
    ],
  ];
  for (const [re, reason] of requestPatterns) {
    if (re.test(stripped)) return reason;
  }

  return null;
}

// ─── Message validation ────────────────────────────────────────────────

/** Structural type guard. Any field missing / wrong type → not a message. */
export function isValidMessage(obj: unknown): obj is ChannelMessage {
  if (obj == null || typeof obj !== "object") return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.channel === "string" &&
    typeof m.from === "string" &&
    typeof m.type === "string" &&
    typeof m.body === "string" &&
    typeof m.timestamp === "number" &&
    Number.isFinite(m.timestamp) &&
    (m.to === undefined || typeof m.to === "string") &&
    (m.acked === undefined || typeof m.acked === "boolean")
  );
}

export interface ParseResult {
  /** Always a well-formed ChannelFile, even on errors (may have empty messages). */
  file: ChannelFile;
  /** Parsed entries that failed isValidMessage() and were skipped. */
  droppedCount: number;
  /** Non-null when the whole payload was unusable (bad JSON or wrong shape). */
  error?: string;
}

/**
 * Safely parse the raw text of a channel file into a ChannelFile.
 * Never throws — returns `{ file: { messages: [] }, error }` on bad JSON or
 * unexpected shape, and drops individual malformed messages when the top-level
 * shape is otherwise fine.
 */
export function parseChannelFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      file: { messages: [] },
      droppedCount: 0,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (raw == null || typeof raw !== "object") {
    return {
      file: { messages: [] },
      droppedCount: 0,
      error: "channel file is not an object",
    };
  }

  const messagesRaw = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messagesRaw)) {
    return {
      file: { messages: [] },
      droppedCount: 0,
      error: "channel file is missing a `messages` array",
    };
  }

  const valid: ChannelMessage[] = [];
  let dropped = 0;
  for (const entry of messagesRaw) {
    if (isValidMessage(entry)) valid.push(entry);
    else dropped++;
  }
  return { file: { messages: valid }, droppedCount: dropped };
}

// ─── Stream framing ────────────────────────────────────────────────────────

/** Default cap for preview strings. */
export const PREVIEW_MAX = 500;

/** Truncate a string to at most `max` characters, adding a trailing ellipsis
 *  when it actually had to be cut. Pure. */
export function previewString(s: string, max: number = PREVIEW_MAX): string {
  if (s == null) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** JSON.stringify that never throws (circular refs / BigInt → `String(v)`). */
export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Split a buffer of concatenated JSON frames into complete frames plus any
 * incomplete remainder. Each frame starts with `{` or `[` and is balanced on
 * brackets, ignoring brackets that appear inside JSON string literals.
 *
 * Tolerates:
 *   - whitespace / newlines between frames (what we send today)
 *   - frames glued without a separator ("}{" — observed in the wild)
 *   - frames split across chunks (last incomplete frame goes to `remainder`)
 *
 * Contract notes:
 *   - Between frames, any byte that isn't a JSON opener (`{` / `[`) is
 *     silently skipped — that covers whitespace, leftover newlines, and the
 *     stray bytes we've occasionally seen from buggy relays. Callers that
 *     need to surface upstream corruption should detect it at the parse step
 *     (invalid-JSON-inside-a-frame) or at higher layers.
 *   - Never throws and never calls `JSON.parse`; callers parse the returned
 *     strings and decide how to handle individual parse errors.
 */
export function splitJsonFrames(buf: string): {
  frames: string[];
  remainder: string;
} {
  const frames: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];

    if (depth === 0 && start === -1) {
      // Between frames — skip any bytes that aren't a JSON opener.
      if (c === "{" || c === "[") {
        start = i;
        depth = 1;
        // Reset string-scanner state at every frame boundary so a stray
        // escape from a malformed prior chunk can't leak into the next frame.
        inString = false;
        escape = false;
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        frames.push(buf.slice(start, i + 1));
        start = -1;
      }
      continue;
    }
  }

  const remainder = start !== -1 ? buf.slice(start) : "";
  return { frames, remainder };
}

// ─── Orientation message ───────────────────────────────────────────────────────

export interface OrientationFields {
  /** First line of the message. Typically "[agent-channel] Comms are now ON.". */
  header: string;
  /** Agent's current display name. */
  agentName: string;
  /** Resolved lobby channel name, or undefined when no lobby could be resolved. */
  lobbyChannel?: string;
  /** Whether the extension sent the presence announce on the lobby for this session. */
  lobbyAutoAnnounced: boolean;
  /** Active display backend name (`cmux`, `tmux`, `noop`). */
  displayName?: string;
}

/**
 * Build the agent-channel orientation body shown when comms are enabled.
 * Pure; no I/O. Always non-triggering at the pi.sendMessage layer (caller's
 * concern). Always safe to call with or without a resolved lobby.
 */
export function buildOrientation(fields: OrientationFields): string {
  const lobbyLine = fields.lobbyChannel
    ? `• Your lobby channel is "${fields.lobbyChannel}". You are already watching it${
        fields.lobbyAutoAnnounced ? " and have announced presence" : ""
      }.`
    : "• No lobby channel could be resolved for this session.";

  const statusLine =
    fields.displayName === "tmux"
      ? `• In tmux mode, subject/status updates are local to this pane (pane border/title), not shared channel metadata.`
      : `• Use "channel_send" to talk to other agents and "channel_status" for the sidebar (sidebar is NOT a message to others).`;

  return [
    fields.header,
    `• Your agent name is "${fields.agentName}".`,
    lobbyLine,
    statusLine,
    `• When you receive a request-shaped message (request, review-request, ping, etc.) send a short ack (type="ack" body="got it, working on X. OVER") FIRST, then do the work, then send results. Silence between receipt and result looks like a dropped message.`,
    `• Default sign-off is OVER (or no suffix). OUT is only correct when BOTH sides have confirmed they are done — e.g. one side sent "approved"/"task-complete" and the other replied "ack. OUT". If you are the first to say "done", use OVER so the other side can confirm.`,
    `• Do not call "channel_unwatch" on a channel where you are still expecting a reply.`,
  ].join("\n");
}
