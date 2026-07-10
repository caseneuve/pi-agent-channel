// ─── In-memory channel store (pure core) ────────────────────────────────

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

export interface StoreOptions {
  /** Max messages per channel before oldest are pruned. Default 1000. */
  maxPerChannel?: number;
}

/**
 * In-memory channel message store. Pure data structure — no I/O.
 * The server wraps this with socket/HTTP handling.
 */
export class ChannelStore {
  private channels: Map<string, ChannelMessage[]> = new Map();
  private maxPerChannel: number;

  constructor(opts?: StoreOptions) {
    this.maxPerChannel = opts?.maxPerChannel ?? 1000;
  }

  /** Publish a message. Returns the message (for fan-out). */
  publish(msg: ChannelMessage): ChannelMessage {
    let msgs = this.channels.get(msg.channel);
    if (!msgs) {
      msgs = [];
      this.channels.set(msg.channel, msgs);
    }
    msgs.push(msg);
    // Prune oldest if over limit
    if (msgs.length > this.maxPerChannel) {
      const excess = msgs.length - this.maxPerChannel;
      msgs.splice(0, excess);
    }
    return msg;
  }

  /** Read messages from a channel with optional filtering. */
  read(
    channel: string,
    opts?: { since?: number; unacked?: boolean; type?: string },
  ): ChannelMessage[] {
    const msgs = this.channels.get(channel) || [];
    let result = msgs;
    if (opts?.since) result = result.filter((m) => m.timestamp > opts.since!);
    if (opts?.unacked) result = result.filter((m) => !m.acked);
    if (opts?.type) result = result.filter((m) => m.type === opts.type);
    return result;
  }

  /** Ack messages. Returns count of newly acked messages. */
  ack(channel: string, messageId: string): { ackedCount: number } {
    const msgs = this.channels.get(channel);
    if (!msgs) return { ackedCount: 0 };

    let ackedCount = 0;
    if (messageId === "*") {
      for (const m of msgs) {
        if (!m.acked) {
          m.acked = true;
          ackedCount++;
        }
      }
    } else if (messageId === "last") {
      const unacked = msgs.filter((m) => !m.acked);
      const last = unacked[unacked.length - 1];
      if (last) {
        last.acked = true;
        ackedCount = 1;
      }
    } else {
      const msg = msgs.find((m) => m.id === messageId);
      if (msg && !msg.acked) {
        msg.acked = true;
        ackedCount = 1;
      }
    }
    return { ackedCount };
  }

  /** List all channels with message counts. */
  list(): { name: string; total: number; unacked: number }[] {
    const result: { name: string; total: number; unacked: number }[] = [];
    for (const [name, msgs] of this.channels) {
      const unacked = msgs.filter((m) => !m.acked).length;
      result.push({ name, total: msgs.length, unacked });
    }
    return result;
  }

  /** Clear all messages from a channel. */
  clear(channel: string): void {
    this.channels.delete(channel);
  }
}
