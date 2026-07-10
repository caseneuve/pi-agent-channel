// ─── Transport + Display interfaces ─────────────────────────────────────
import type { ChannelMessage, FilterOpts } from "./core";

// ─── Parse-error reporting ──────────────────────────────────────────────

export interface ParseErrorInfo {
  /** Which transport saw the error ("uds", "http", "file"). */
  transport: string;
  /** Human-readable error (JSON.parse message or our shape-check label). */
  error: string;
  /** Truncated preview of the offending bytes — always safe to log. */
  rawPreview: string;
  /** Channel the frame was destined for, if we could tell before the error. */
  channel?: string;
}

// ─── MessageTransport: messaging over any medium ────────────────────────
export interface MessageTransport {
  /** Transport name, e.g. "file", "uds", "http" */
  readonly name: string;

  /**
   * Optional sink for malformed frames the transport had to drop.
   * Set by the extension host to surface the error to the agent / UI.
   * Transports MUST NOT throw if this is undefined.
   */
  onParseError?: (info: ParseErrorInfo) => void;

  /** Publish a message to a channel. */
  publish(msg: ChannelMessage): Promise<void>;

  /** Read messages from a channel with optional filtering. */
  read(channel: string, opts?: FilterOpts): Promise<ChannelMessage[]>;

  /** Ack a message. Supports "last", "*", or specific id. */
  ack(channel: string, messageId: string): Promise<{ ackedCount: number }>;

  /** Subscribe to a channel for push delivery of new messages. */
  subscribe(
    channel: string,
    callback: (msgs: ChannelMessage[]) => void,
    opts?: { intervalMs?: number },
  ): void;

  /** Unsubscribe from a channel. */
  unsubscribe(channel: string): void;

  /** Unsubscribe from all channels. */
  unsubscribeAll(): void;
}

// ─── StatusDisplay: local sidebar/notification output ───────────────────
export interface StatusDisplay {
  /** Display name, e.g. "cmux", "tmux", "noop" */
  readonly name: string;

  /** Set a sidebar status pill. */
  setStatus(key: string, value: string, icon?: string): Promise<void>;

  /** Set sidebar progress bar. */
  setProgress(fraction: number, label: string): Promise<void>;

  /** Clear sidebar progress bar. */
  clearProgress(): Promise<void>;

  /** Append a log line to the sidebar. */
  log(message: string, level?: string, source?: string): Promise<void>;

  /** Send a notification to the human. */
  notify(title: string, body: string): Promise<void>;
}
