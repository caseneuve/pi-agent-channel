import { describe, test, expect } from "bun:test";
import {
  channelPath,
  filterMessages,
  ackMessages,
  shouldTriggerTurn,
  endsWithOut,
  endsWithOver,
  classifySuffix,
  detectOutMisuse,
  buildOrientation,
  isValidMessage,
  parseChannelFile,
  previewString,
  safeStringify,
  splitJsonFrames,
  type ChannelMessage,
  type ChannelFile,
} from "./core";

// ─── Helpers ────────────────────────────────────────────────────────────

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "m1",
    channel: "test/ch",
    from: "agent-a",
    type: "status",
    body: "hello",
    timestamp: 1000,
    ...overrides,
  };
}

function file(...msgs: ChannelMessage[]): ChannelFile {
  return { messages: msgs };
}

// ─── channelPath ────────────────────────────────────────────────────────

describe("channelPath", () => {
  test("simple name", () => {
    expect(channelPath("/tmp/ch", "my-channel")).toBe(
      "/tmp/ch/my-channel.json",
    );
  });

  test("replaces unsafe characters with underscores", () => {
    expect(channelPath("/tmp/ch", "project/review")).toBe(
      "/tmp/ch/project_review.json",
    );
  });

  test("preserves dots and hyphens", () => {
    expect(channelPath("/tmp/ch", "a.b-c")).toBe("/tmp/ch/a.b-c.json");
  });

  test("replaces spaces and special chars", () => {
    expect(channelPath("/tmp/ch", "my channel!@#")).toBe(
      "/tmp/ch/my_channel___.json",
    );
  });
});

// ─── filterMessages ─────────────────────────────────────────────────────

describe("filterMessages", () => {
  const m1 = msg({ id: "1", timestamp: 100, acked: false, type: "status" });
  const m2 = msg({ id: "2", timestamp: 200, acked: true, type: "review" });
  const m3 = msg({ id: "3", timestamp: 300, acked: false, type: "status" });
  const all = [m1, m2, m3];

  test("no opts returns all messages", () => {
    expect(filterMessages(all)).toEqual(all);
  });

  test("filters by since", () => {
    expect(filterMessages(all, { since: 150 })).toEqual([m2, m3]);
  });

  test("filters by unacked", () => {
    expect(filterMessages(all, { unacked: true })).toEqual([m1, m3]);
  });

  test("filters by type", () => {
    expect(filterMessages(all, { type: "review" })).toEqual([m2]);
  });

  test("combines since + unacked", () => {
    expect(filterMessages(all, { since: 150, unacked: true })).toEqual([m3]);
  });

  test("combines all filters", () => {
    expect(
      filterMessages(all, { since: 50, unacked: true, type: "status" }),
    ).toEqual([m1, m3]);
  });

  test("empty input returns empty", () => {
    expect(filterMessages([], { unacked: true })).toEqual([]);
  });
});

// ─── ackMessages ────────────────────────────────────────────────────────

describe("ackMessages", () => {
  test("ack all (*) marks all unacked messages", () => {
    const m1 = msg({ id: "1", acked: false });
    const m2 = msg({ id: "2", acked: true });
    const m3 = msg({ id: "3", acked: false });
    const input = file(m1, m2, m3);

    const result = ackMessages(input, "*");

    expect(result.ackedCount).toBe(2);
    expect(result.file.messages.every((m) => m.acked)).toBe(true);
  });

  test("ack last marks only the last unacked message", () => {
    const m1 = msg({ id: "1", acked: false });
    const m2 = msg({ id: "2", acked: false });
    const input = file(m1, m2);

    const result = ackMessages(input, "last");

    expect(result.ackedCount).toBe(1);
    expect(result.file.messages[0].acked).toBe(false);
    expect(result.file.messages[1].acked).toBe(true);
  });

  test("ack specific id marks that message", () => {
    const m1 = msg({ id: "abc", acked: false });
    const m2 = msg({ id: "def", acked: false });
    const input = file(m1, m2);

    const result = ackMessages(input, "abc");

    expect(result.ackedCount).toBe(1);
    expect(result.file.messages[0].acked).toBe(true);
    expect(result.file.messages[1].acked).toBe(false);
  });

  test("returns 0 when no messages match", () => {
    const input = file(msg({ id: "1", acked: true }));
    expect(ackMessages(input, "last").ackedCount).toBe(0);
    expect(ackMessages(input, "*").ackedCount).toBe(0);
    expect(ackMessages(input, "nonexistent").ackedCount).toBe(0);
  });

  test("does not mutate the original file", () => {
    const m1 = msg({ id: "1", acked: false });
    const input = file(m1);
    const originalAcked = input.messages[0].acked;

    ackMessages(input, "*");

    expect(input.messages[0].acked).toBe(originalAcked);
  });

  test("returns new ChannelFile object", () => {
    const input = file(msg({ id: "1", acked: false }));
    const result = ackMessages(input, "*");
    expect(result.file).not.toBe(input);
    expect(result.file.messages[0]).not.toBe(input.messages[0]);
  });

  test("empty file returns 0", () => {
    const result = ackMessages(file(), "*");
    expect(result.ackedCount).toBe(0);
    expect(result.file.messages).toEqual([]);
  });
});

// ─── shouldTriggerTurn ──────────────────────────────────────────────────

describe("shouldTriggerTurn", () => {
  test("presence messages never trigger", () => {
    expect(shouldTriggerTurn(msg({ type: "presence", body: "joined" }))).toBe(
      false,
    );
  });

  test("ack messages never trigger (peer-ack confirms delivery, no action owed)", () => {
    expect(
      shouldTriggerTurn(msg({ type: "ack", body: "got it, on it. OVER" })),
    ).toBe(false);
    // even an ack with no suffix is still suppressed — the type is the signal
    expect(shouldTriggerTurn(msg({ type: "ack", body: "got it" }))).toBe(false);
  });

  test("body ending with OUT does not trigger", () => {
    expect(shouldTriggerTurn(msg({ body: "Done. OUT" }))).toBe(false);
  });

  test("body ending with out (lowercase) does not trigger", () => {
    expect(shouldTriggerTurn(msg({ body: "Done. out" }))).toBe(false);
  });

  test("body ending with OUT and trailing whitespace does not trigger", () => {
    expect(shouldTriggerTurn(msg({ body: "Done. OUT  \n" }))).toBe(false);
  });

  test("body ending with OVER triggers", () => {
    expect(shouldTriggerTurn(msg({ body: "Your turn. OVER" }))).toBe(true);
  });

  test("body with no suffix triggers", () => {
    expect(shouldTriggerTurn(msg({ body: "Please review this" }))).toBe(true);
  });

  test("OUT in the middle does not suppress trigger", () => {
    expect(shouldTriggerTurn(msg({ body: "OUT of ideas, help me" }))).toBe(
      true,
    );
  });

  test("status type triggers", () => {
    expect(shouldTriggerTurn(msg({ type: "status", body: "working" }))).toBe(
      true,
    );
  });
});

// ─── endsWithOut ───────────────────────────────────────────────────────────

describe("endsWithOut", () => {
  test("detects OUT, out, Out at end", () => {
    expect(endsWithOut("done. OUT")).toBe(true);
    expect(endsWithOut("done. out")).toBe(true);
    expect(endsWithOut("done. Out")).toBe(true);
  });

  test("tolerates trailing whitespace", () => {
    expect(endsWithOut("done. OUT   \n\t")).toBe(true);
  });

  test("does not match OUT inside words", () => {
    expect(endsWithOut("OUTput attached.")).toBe(false);
  });

  test("returns false for bodies that don't end with OUT", () => {
    expect(endsWithOut("your turn. OVER")).toBe(false);
    expect(endsWithOut("a plain body")).toBe(false);
    expect(endsWithOut("OUT of ideas, help me")).toBe(false);
  });
});

// ─── endsWithOver ────────────────────────────────────────────────────

describe("endsWithOver", () => {
  test("detects OVER/over/Over at end", () => {
    expect(endsWithOver("your turn. OVER")).toBe(true);
    expect(endsWithOver("your turn. over")).toBe(true);
    expect(endsWithOver("your turn. Over")).toBe(true);
  });

  test("tolerates trailing whitespace", () => {
    expect(endsWithOver("your turn. OVER\n")).toBe(true);
  });

  test("does not match OVER inside words", () => {
    expect(endsWithOver("OVERflow detected.")).toBe(false);
  });

  test("returns false for non-OVER endings", () => {
    expect(endsWithOver("done. OUT")).toBe(false);
    expect(endsWithOver("plain body")).toBe(false);
  });
});

// ─── classifySuffix ──────────────────────────────────────────────────────

describe("classifySuffix", () => {
  test("returns 'OUT' for OUT-terminated bodies", () => {
    expect(classifySuffix("done. OUT")).toBe("OUT");
    expect(classifySuffix("done. out\n")).toBe("OUT");
  });

  test("returns 'OVER' for OVER-terminated bodies", () => {
    expect(classifySuffix("your turn. OVER")).toBe("OVER");
    expect(classifySuffix("your turn. over  ")).toBe("OVER");
  });

  test("returns 'none' for bodies with no suffix", () => {
    expect(classifySuffix("plain body")).toBe("none");
    expect(classifySuffix("")).toBe("none");
    expect(classifySuffix("OUT of ideas, help me")).toBe("none");
  });

  test("OUT wins when both appear, mirroring shouldTriggerTurn", () => {
    // pathological input — body ends with OUT so receiver suppresses turn;
    // telemetry reflects what the receiver actually does.
    expect(classifySuffix("OVER OUT")).toBe("OUT");
  });
});

// ─── detectOutMisuse ───────────────────────────────────────────────────────

describe("detectOutMisuse", () => {
  test("returns null when body does not end with OUT", () => {
    expect(detectOutMisuse("your turn. OVER")).toBeNull();
    expect(detectOutMisuse("nothing special here")).toBeNull();
  });

  test("returns null for OUT with a clean closing statement", () => {
    expect(detectOutMisuse("all fixes verified. OUT")).toBeNull();
    expect(detectOutMisuse("done, thanks. OUT")).toBeNull();
  });

  test("returns null for OUT with a closing message type", () => {
    // type='approved' is a legitimate conversation terminator
    expect(detectOutMisuse("can you double-check? OUT", "approved")).toBeNull();
    expect(detectOutMisuse("looks good. OUT", "task-complete")).toBeNull();
  });

  test("flags OUT on reply-expecting message types regardless of body", () => {
    // Body has no explicit question/request words but the type itself
    // encodes an expectation of reply — OUT is wrong.
    expect(detectOutMisuse("diff attached. OUT", "review-request")).toMatch(
      /type "review-request" expects a reply/,
    );
    expect(detectOutMisuse("here it is. OUT", "request")).toMatch(
      /type "request" expects a reply/,
    );
    expect(detectOutMisuse("anyone there? OUT", "ping")).toMatch(
      /type "ping" expects a reply/,
    );
    expect(detectOutMisuse("code below. OUT", "code-review")).toMatch(
      /type "code-review" expects a reply/,
    );
    expect(detectOutMisuse("details follow. OUT", "review-followup")).toMatch(
      /type "review-followup" expects a reply/,
    );
  });

  test("reply-expecting type check is case-insensitive", () => {
    expect(detectOutMisuse("anything. OUT", "Review-Request")).toMatch(
      /expects a reply/,
    );
  });

  test("flags question marks", () => {
    expect(detectOutMisuse("is the build green? OUT")).toMatch(/question mark/);
  });

  test("flags 'please'", () => {
    expect(detectOutMisuse("Please review the diff. OUT")).toMatch(/please/);
  });

  test("flags 'can you' / 'could you' / 'would you' / 'will you'", () => {
    expect(detectOutMisuse("can you ack this. OUT")).toMatch(/request/);
    expect(detectOutMisuse("could you confirm. OUT")).toMatch(/request/);
    expect(detectOutMisuse("would you take a look. OUT")).toMatch(/request/);
    expect(detectOutMisuse("will you approve. OUT")).toMatch(/request/);
  });

  test("flags 'let me know' / 'lmk'", () => {
    expect(detectOutMisuse("let me know what you think. OUT")).toMatch(
      /respond/,
    );
    expect(detectOutMisuse("lmk if ok. OUT")).toMatch(/respond/);
  });

  test("flags 'waiting for' / 'standby for' / 'ready for'", () => {
    expect(detectOutMisuse("waiting for your ack. OUT")).toMatch(/waiting/);
    expect(detectOutMisuse("standby for next batch. OUT")).toMatch(/waiting/);
  });

  test("flags 'review this' and siblings", () => {
    expect(detectOutMisuse("review the patch. OUT")).toMatch(/act/);
    expect(detectOutMisuse("verify my fixes. OUT")).toMatch(/act/);
  });

  test("flags explicit turn-handoff phrasings", () => {
    expect(detectOutMisuse("your turn. OUT")).toMatch(/OVER/);
    expect(detectOutMisuse("over to you. OUT")).toMatch(/OVER/);
  });

  test("empty body with OUT is not flagged", () => {
    expect(detectOutMisuse("OUT")).toBeNull();
    expect(detectOutMisuse("   OUT  ")).toBeNull();
  });

  test("case-insensitive", () => {
    expect(detectOutMisuse("PLEASE confirm. out")).toMatch(/please/i);
  });
});

// ─── isValidMessage ────────────────────────────────────────────────────

describe("isValidMessage", () => {
  test("accepts a fully formed message", () => {
    expect(isValidMessage(msg())).toBe(true);
  });

  test("accepts an optional `to` field", () => {
    expect(isValidMessage(msg({ to: "agent-b" }))).toBe(true);
  });

  test("accepts an optional `acked` field", () => {
    expect(isValidMessage(msg({ acked: true }))).toBe(true);
  });

  test("rejects null and undefined", () => {
    expect(isValidMessage(null)).toBe(false);
    expect(isValidMessage(undefined)).toBe(false);
  });

  test("rejects primitives", () => {
    expect(isValidMessage("hello")).toBe(false);
    expect(isValidMessage(42)).toBe(false);
    expect(isValidMessage(true)).toBe(false);
  });

  test("rejects when required string fields are missing", () => {
    const base = msg();
    const { id: _id, ...noId } = base;
    const { body: _body, ...noBody } = base;
    const { from: _from, ...noFrom } = base;
    const { channel: _channel, ...noChannel } = base;
    const { type: _type, ...noType } = base;
    const { timestamp: _ts, ...noTimestamp } = base;
    expect(isValidMessage(noId)).toBe(false);
    expect(isValidMessage(noBody)).toBe(false);
    expect(isValidMessage(noFrom)).toBe(false);
    expect(isValidMessage(noChannel)).toBe(false);
    expect(isValidMessage(noType)).toBe(false);
    expect(isValidMessage(noTimestamp)).toBe(false);
  });

  test("rejects when timestamp is not a number", () => {
    expect(isValidMessage({ ...msg(), timestamp: "now" })).toBe(false);
  });

  test("rejects when timestamp is NaN or Infinity", () => {
    expect(isValidMessage({ ...msg(), timestamp: Number.NaN })).toBe(false);
    expect(
      isValidMessage({ ...msg(), timestamp: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });

  test("rejects when `to` is present but not a string", () => {
    expect(isValidMessage({ ...msg(), to: 12 })).toBe(false);
  });

  test("rejects when `acked` is present but not a boolean", () => {
    expect(isValidMessage({ ...msg(), acked: "yes" })).toBe(false);
  });
});

// ─── parseChannelFile ──────────────────────────────────────────────────

describe("parseChannelFile", () => {
  test("parses a clean file", () => {
    const text = JSON.stringify({ messages: [msg({ id: "a" })] });
    const result = parseChannelFile(text);
    expect(result.error).toBeUndefined();
    expect(result.droppedCount).toBe(0);
    expect(result.file.messages).toHaveLength(1);
    expect(result.file.messages[0].id).toBe("a");
  });

  test("returns empty file + error on invalid JSON", () => {
    const result = parseChannelFile("{not valid json");
    expect(result.file.messages).toEqual([]);
    expect(result.droppedCount).toBe(0);
    expect(result.error).toContain("invalid JSON");
  });

  test("returns empty file + error on non-object JSON", () => {
    const result = parseChannelFile("[1, 2, 3]");
    expect(result.file.messages).toEqual([]);
    expect(result.error).toContain("messages");
  });

  test("returns empty file + error when messages is missing", () => {
    const result = parseChannelFile(JSON.stringify({ foo: "bar" }));
    expect(result.file.messages).toEqual([]);
    expect(result.error).toContain("messages");
  });

  test("returns empty file + error when messages is not an array", () => {
    const result = parseChannelFile(JSON.stringify({ messages: "oops" }));
    expect(result.file.messages).toEqual([]);
    expect(result.error).toContain("messages");
  });

  test("drops malformed message entries but keeps valid ones", () => {
    const text = JSON.stringify({
      messages: [
        msg({ id: "ok1" }),
        { id: "missing-fields" },
        null,
        "not-a-message",
        msg({ id: "ok2" }),
      ],
    });
    const result = parseChannelFile(text);
    expect(result.error).toBeUndefined();
    expect(result.droppedCount).toBe(3);
    expect(result.file.messages.map((m) => m.id)).toEqual(["ok1", "ok2"]);
  });

  test("never throws on null/garbage top-level JSON", () => {
    expect(() => parseChannelFile("null")).not.toThrow();
    expect(() => parseChannelFile('"a string"')).not.toThrow();
    expect(() => parseChannelFile("42")).not.toThrow();
  });
});

// ─── splitJsonFrames ──────────────────────────────────────────────────

describe("splitJsonFrames", () => {
  test("empty buffer yields no frames", () => {
    expect(splitJsonFrames("")).toEqual({ frames: [], remainder: "" });
  });

  test("single complete frame with trailing newline", () => {
    const r = splitJsonFrames('{"a":1}\n');
    expect(r.frames).toEqual(['{"a":1}']);
    expect(r.remainder).toBe("");
  });

  test("two newline-separated frames", () => {
    const r = splitJsonFrames('{"a":1}\n{"b":2}\n');
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.remainder).toBe("");
  });

  test("two frames glued without a separator (}{ boundary)", () => {
    const r = splitJsonFrames('{"a":1}{"b":2}');
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.remainder).toBe("");
  });

  test("incomplete trailing frame goes to remainder", () => {
    const r = splitJsonFrames('{"a":1}\n{"b":');
    expect(r.frames).toEqual(['{"a":1}']);
    expect(r.remainder).toBe('{"b":');
  });

  test("braces inside string literals do not confuse the scanner", () => {
    const r = splitJsonFrames('{"body":"}}}{{"}\n{"a":1}');
    expect(r.frames).toEqual(['{"body":"}}}{{"}', '{"a":1}']);
    expect(r.remainder).toBe("");
  });

  test("escaped quotes inside string literals are respected", () => {
    const r = splitJsonFrames('{"body":"quote \\" then }"}');
    expect(r.frames).toEqual(['{"body":"quote \\" then }"}']);
  });

  test("nested objects count toward depth correctly", () => {
    const r = splitJsonFrames('{"a":{"b":{"c":1}}}{"x":2}');
    expect(r.frames).toEqual(['{"a":{"b":{"c":1}}}', '{"x":2}']);
  });

  test("arrays as top-level frames work", () => {
    const r = splitJsonFrames("[1,2,3][4,5]");
    expect(r.frames).toEqual(["[1,2,3]", "[4,5]"]);
  });

  test("whitespace between frames is skipped", () => {
    const r = splitJsonFrames('{"a":1}   \n\t {"b":2}');
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("real-world example: message frame immediately followed by response frame", () => {
    const frame1 = JSON.stringify({
      type: "message",
      channel: "test",
      msg: { id: "x", body: "hi" },
    });
    const frame2 = JSON.stringify({ type: "response", reqId: "r1", data: 42 });
    const r = splitJsonFrames(frame1 + frame2);
    expect(r.frames).toEqual([frame1, frame2]);
    expect(r.remainder).toBe("");
  });

  test("partial chunks can be reassembled across calls", () => {
    // First chunk has one complete frame and a partial second
    const first = splitJsonFrames('{"a":1}\n{"b":');
    expect(first.frames).toEqual(['{"a":1}']);
    expect(first.remainder).toBe('{"b":');
    // Next chunk completes the frame plus starts another
    const second = splitJsonFrames(first.remainder + '2}\n{"c"');
    expect(second.frames).toEqual(['{"b":2}']);
    expect(second.remainder).toBe('{"c"');
  });

  test("only-garbage input yields no frames and empty remainder", () => {
    const r = splitJsonFrames("xxx ))) zzz");
    expect(r.frames).toEqual([]);
    expect(r.remainder).toBe("");
  });

  test("garbage between frames is silently skipped (documented contract)", () => {
    const r = splitJsonFrames('junk{"a":1}more junk{"b":2}tail');
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}']);
    // `tail` after the last frame is non-opener garbage — silently eaten.
    expect(r.remainder).toBe("");
  });

  test("\\uXXXX escapes inside strings do not confuse the scanner", () => {
    // The literal JSON string value "A\u007D B" contains a `}` (0x7D) in its
    // decoded form but the escape is six source characters; the scanner
    // treats it as part of the string, so the frame boundary is correct.
    const frame = '{"body":"A\\u007D B"}';
    const r = splitJsonFrames(frame + '{"x":1}');
    expect(r.frames).toEqual([frame, '{"x":1}']);
    // Double-check the frame is still valid JSON when parsed.
    expect(JSON.parse(r.frames[0]).body).toBe("A} B");
  });

  test("escaped backslash before a quote does not re-enter string mode", () => {
    // `\\` is an escaped backslash, then `"` closes the string.
    const frame = '{"s":"end\\\\"}';
    const r = splitJsonFrames(frame);
    expect(r.frames).toEqual([frame]);
    expect(JSON.parse(r.frames[0]).s).toBe("end\\");
  });
});

// ─── previewString + safeStringify ──────────────────────────────────────

describe("previewString", () => {
  test("returns empty string for null/undefined", () => {
    expect(previewString(null as unknown as string)).toBe("");
    expect(previewString(undefined as unknown as string)).toBe("");
  });

  test("passes short strings through unchanged", () => {
    expect(previewString("hello", 10)).toBe("hello");
  });

  test("truncates + ellipses strings over the cap", () => {
    expect(previewString("abcdefghij", 4)).toBe("abcd…");
  });

  test("respects the default cap of 500 chars", () => {
    const long = "x".repeat(600);
    const out = previewString(long);
    expect(out.length).toBe(501); // 500 + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("safeStringify", () => {
  test("stringifies a plain object", () => {
    expect(safeStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  test("handles circular references without throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => safeStringify(cyclic)).not.toThrow();
    // Fallback just stringifies to `[object Object]`.
    expect(safeStringify(cyclic)).toContain("object");
  });

  test("handles BigInt without throwing", () => {
    expect(() => safeStringify({ n: 1n })).not.toThrow();
  });

  test("undefined stringifies to the string 'undefined'", () => {
    expect(safeStringify(undefined)).toBe("undefined");
  });
});

// ─── buildOrientation ──────────────────────────────────────────────────────

describe("buildOrientation", () => {
  const baseFields = {
    header: "[agent-channel] Comms are now ON.",
    agentName: "reviewer",
    lobbyAutoAnnounced: false,
    displayName: "cmux",
  };

  test("starts with the provided header", () => {
    const out = buildOrientation(baseFields);
    expect(out.startsWith("[agent-channel] Comms are now ON.\n")).toBe(true);
  });

  test("includes the agent name verbatim", () => {
    const out = buildOrientation({ ...baseFields, agentName: "agent-x" });
    expect(out).toContain('Your agent name is "agent-x".');
  });

  test("renders the 'no lobby resolved' line when lobbyChannel is undefined", () => {
    const out = buildOrientation(baseFields);
    expect(out).toContain(
      "No lobby channel could be resolved for this session.",
    );
    expect(out).not.toContain("Your lobby channel is");
  });

  test("renders the lobby line without the announce clause when not announced", () => {
    const out = buildOrientation({
      ...baseFields,
      lobbyChannel: "project/lobby",
      lobbyAutoAnnounced: false,
    });
    expect(out).toContain(
      'Your lobby channel is "project/lobby". You are already watching it.',
    );
    expect(out).not.toContain("announced presence");
  });

  test("appends 'and have announced presence' when lobby was auto-announced", () => {
    const out = buildOrientation({
      ...baseFields,
      lobbyChannel: "project/lobby",
      lobbyAutoAnnounced: true,
    });
    expect(out).toContain(
      'Your lobby channel is "project/lobby". You are already watching it and have announced presence.',
    );
  });

  test("includes the protocol bullets", () => {
    const out = buildOrientation(baseFields);
    expect(out).toContain("send a short ack");
    expect(out).toContain("BOTH sides have confirmed");
    expect(out).toContain("channel_unwatch");
    expect(out).toContain("sidebar is NOT a message to others");
  });

  test("uses tmux-specific status/subject guidance in tmux mode", () => {
    const out = buildOrientation({ ...baseFields, displayName: "tmux" });
    expect(out).toContain("subject/status updates are local to this pane");
    expect(out).toContain("not shared channel metadata");
    expect(out).not.toContain("sidebar is NOT a message to others");
  });

  test("does NOT include the legacy 'Comms are currently OFF' bullet", () => {
    const out = buildOrientation(baseFields);
    expect(out).not.toContain("Comms are currently OFF");
    expect(out).not.toMatch(/\bComms are ON\b/);
  });
});
