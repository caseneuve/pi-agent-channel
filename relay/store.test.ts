import { describe, test, expect, beforeEach } from "bun:test";
import { ChannelStore, type ChannelMessage } from "./store";

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    channel: "test/ch",
    from: "agent-a",
    type: "status",
    body: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ChannelStore", () => {
  let store: ChannelStore;

  beforeEach(() => {
    store = new ChannelStore();
  });

  // ── publish ──

  test("publish stores message", () => {
    const m = msg();
    store.publish(m);
    const msgs = store.read(m.channel);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(m.id);
  });

  test("publish returns the message", () => {
    const m = msg();
    const result = store.publish(m);
    expect(result).toBe(m);
  });

  test("publish prunes oldest when over max", () => {
    const small = new ChannelStore({ maxPerChannel: 3 });
    small.publish(msg({ id: "a", channel: "ch" }));
    small.publish(msg({ id: "b", channel: "ch" }));
    small.publish(msg({ id: "c", channel: "ch" }));
    small.publish(msg({ id: "d", channel: "ch" }));

    const msgs = small.read("ch");
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe("b");
    expect(msgs[2].id).toBe("d");
  });

  // ── read ──

  test("read returns empty for unknown channel", () => {
    expect(store.read("nonexistent")).toEqual([]);
  });

  test("read returns all messages", () => {
    store.publish(msg({ channel: "ch" }));
    store.publish(msg({ channel: "ch" }));
    expect(store.read("ch")).toHaveLength(2);
  });

  test("read filters by since", () => {
    store.publish(msg({ channel: "ch", timestamp: 100 }));
    store.publish(msg({ channel: "ch", timestamp: 300 }));
    const msgs = store.read("ch", { since: 200 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(300);
  });

  test("read filters by unacked", () => {
    store.publish(msg({ channel: "ch", acked: true }));
    store.publish(msg({ channel: "ch", acked: false }));
    const msgs = store.read("ch", { unacked: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].acked).toBe(false);
  });

  test("read filters by type", () => {
    store.publish(msg({ channel: "ch", type: "status" }));
    store.publish(msg({ channel: "ch", type: "review" }));
    const msgs = store.read("ch", { type: "review" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("review");
  });

  // ── ack ──

  test("ack specific message", () => {
    const m = msg({ channel: "ch" });
    store.publish(m);
    const result = store.ack("ch", m.id);
    expect(result.ackedCount).toBe(1);
    expect(store.read("ch", { unacked: true })).toHaveLength(0);
  });

  test("ack * marks all", () => {
    store.publish(msg({ channel: "ch" }));
    store.publish(msg({ channel: "ch" }));
    const result = store.ack("ch", "*");
    expect(result.ackedCount).toBe(2);
  });

  test("ack last marks most recent unacked", () => {
    store.publish(msg({ channel: "ch", id: "first" }));
    store.publish(msg({ channel: "ch", id: "second" }));
    const result = store.ack("ch", "last");
    expect(result.ackedCount).toBe(1);
    const unacked = store.read("ch", { unacked: true });
    expect(unacked).toHaveLength(1);
    expect(unacked[0].id).toBe("first");
  });

  test("ack returns 0 for unknown channel", () => {
    expect(store.ack("nope", "*").ackedCount).toBe(0);
  });

  test("ack returns 0 for already-acked message", () => {
    const m = msg({ channel: "ch" });
    store.publish(m);
    store.ack("ch", m.id);
    expect(store.ack("ch", m.id).ackedCount).toBe(0);
  });

  // ── list ──

  test("list returns all channels", () => {
    store.publish(msg({ channel: "a" }));
    store.publish(msg({ channel: "b" }));
    store.publish(msg({ channel: "b", acked: true }));
    const list = store.list();
    expect(list).toHaveLength(2);

    const a = list.find((c) => c.name === "a")!;
    expect(a.total).toBe(1);
    expect(a.unacked).toBe(1);

    const b = list.find((c) => c.name === "b")!;
    expect(b.total).toBe(2);
    expect(b.unacked).toBe(1);
  });

  test("list returns empty when no channels", () => {
    expect(store.list()).toEqual([]);
  });

  // ── clear ──

  test("clear removes channel", () => {
    store.publish(msg({ channel: "ch" }));
    store.clear("ch");
    expect(store.read("ch")).toEqual([]);
    expect(store.list()).toEqual([]);
  });
});
