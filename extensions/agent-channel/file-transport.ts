// ─── FileTransport: poll-based, zero-config fallback ────────────────────
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  channelPath,
  filterMessages,
  ackMessages,
  parseChannelFile,
  type ChannelMessage,
  type ChannelFile,
  type FilterOpts,
} from "./core";
import type { MessageTransport, ParseErrorInfo } from "./interfaces";

export const DEFAULT_CHANNEL_DIR = path.join(os.homedir(), ".agent-channels");

// ─── File I/O helpers ───────────────────────────────────────────────────

export function readChannelFile(
  channelDir: string,
  channel: string,
): ChannelFile {
  const p = channelPath(channelDir, channel);
  if (!fs.existsSync(p)) return { messages: [] };
  let text: string;
  try {
    text = fs.readFileSync(p, "utf-8");
  } catch (err) {
    console.error(
      `[agent-channel] failed to read ${p}: ${err instanceof Error ? err.message : err}`,
    );
    return { messages: [] };
  }
  const result = parseChannelFile(text);
  if (result.error) {
    console.error(`[agent-channel] ${p}: ${result.error}`);
  }
  if (result.droppedCount > 0) {
    console.error(
      `[agent-channel] ${p}: dropped ${result.droppedCount} malformed message(s)`,
    );
  }
  return result.file;
}

export function writeChannelFile(
  channelDir: string,
  channel: string,
  data: ChannelFile,
): void {
  fs.mkdirSync(channelDir, { recursive: true });
  fs.writeFileSync(
    channelPath(channelDir, channel),
    JSON.stringify(data, null, 2),
  );
}

// ─── FileTransport ──────────────────────────────────────────────────────
// subscribe() uses an internal poller — the only transport that needs one.

export class FileTransport implements MessageTransport {
  readonly name = "file";
  onParseError?: (info: ParseErrorInfo) => void;
  readonly channelDir: string;

  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastSeen: Map<string, number> = new Map();

  constructor(channelDir: string) {
    this.channelDir = channelDir;
  }

  async publish(msg: ChannelMessage): Promise<void> {
    const file = readChannelFile(this.channelDir, msg.channel);
    file.messages.push(msg);
    writeChannelFile(this.channelDir, msg.channel, file);
  }

  async read(channel: string, opts?: FilterOpts): Promise<ChannelMessage[]> {
    const file = readChannelFile(this.channelDir, channel);
    return filterMessages(file.messages, opts);
  }

  async ack(
    channel: string,
    messageId: string,
  ): Promise<{ ackedCount: number }> {
    const original = readChannelFile(this.channelDir, channel);
    const result = ackMessages(original, messageId);
    if (result.ackedCount > 0) {
      writeChannelFile(this.channelDir, channel, result.file);
    }
    return { ackedCount: result.ackedCount };
  }

  subscribe(
    channel: string,
    callback: (msgs: ChannelMessage[]) => void,
    opts?: { intervalMs?: number },
  ): void {
    this.unsubscribe(channel);

    const intervalMs = opts?.intervalMs ?? 3000;
    this.lastSeen.set(channel, Date.now());

    const timer = setInterval(async () => {
      const since = this.lastSeen.get(channel) || 0;
      const msgs = await this.read(channel, { since });
      if (msgs.length > 0) {
        this.lastSeen.set(channel, Math.max(...msgs.map((m) => m.timestamp)));
        callback(msgs);
      }
    }, intervalMs);

    this.timers.set(channel, timer);
  }

  unsubscribe(channel: string): void {
    const timer = this.timers.get(channel);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(channel);
      this.lastSeen.delete(channel);
    }
  }

  unsubscribeAll(): void {
    for (const [ch] of this.timers) {
      this.unsubscribe(ch);
    }
  }
}
