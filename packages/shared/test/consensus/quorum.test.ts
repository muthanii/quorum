import { describe, expect, it } from "vitest";

import { ACTIVE_WINDOW_MS } from "../../src/constants";
import { activeMemberIds, type QuorumMember } from "../../src/consensus/quorum";

const NOW = 10_000_000;

function member(id: string, overrides: Partial<QuorumMember> = {}): QuorumMember {
  return { id, role: "editor", lastSeenAt: 0, ...overrides };
}

describe("activeMemberIds", () => {
  it("includes a connected member even when lastSeenAt is ancient", () => {
    const result = activeMemberIds({
      members: [member("mem_a", { lastSeenAt: 0 })],
      connectedIds: ["mem_a"],
      now: NOW,
    });
    expect(result).toEqual(["mem_a"]);
  });

  it("includes a disconnected member seen within the window", () => {
    const result = activeMemberIds({
      members: [member("mem_a", { lastSeenAt: NOW - ACTIVE_WINDOW_MS + 1 })],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual(["mem_a"]);
  });

  it("includes a member seen exactly at the window boundary", () => {
    const result = activeMemberIds({
      members: [member("mem_a", { lastSeenAt: NOW - ACTIVE_WINDOW_MS })],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual(["mem_a"]);
  });

  it("excludes a member seen one millisecond before the window boundary", () => {
    const result = activeMemberIds({
      members: [member("mem_a", { lastSeenAt: NOW - ACTIVE_WINDOW_MS - 1 })],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it("excludes viewers from the voting quorum even when connected and recently seen", () => {
    const result = activeMemberIds({
      members: [
        member("mem_viewer", { role: "viewer", lastSeenAt: NOW }),
        member("mem_editor", { role: "editor", lastSeenAt: NOW }),
        member("mem_owner", { role: "owner", lastSeenAt: NOW }),
      ],
      connectedIds: ["mem_viewer", "mem_editor", "mem_owner"],
      now: NOW,
    });
    expect(result).toEqual(["mem_editor", "mem_owner"]);
  });

  it("owners and editors both count toward the quorum", () => {
    const result = activeMemberIds({
      members: [
        member("mem_owner", { role: "owner", lastSeenAt: NOW - 1 }),
        member("mem_editor", { role: "editor", lastSeenAt: NOW - 1 }),
      ],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual(["mem_owner", "mem_editor"]);
  });

  it("respects a custom activeWindowMs", () => {
    const input = {
      members: [member("mem_a", { lastSeenAt: NOW - 60_000 })],
      connectedIds: [] as string[],
      now: NOW,
    };
    expect(activeMemberIds({ ...input, activeWindowMs: 30_000 })).toEqual([]);
    expect(activeMemberIds({ ...input, activeWindowMs: 60_000 })).toEqual(["mem_a"]);
  });

  it("deduplicates repeated member rows, keeping first-occurrence order", () => {
    const result = activeMemberIds({
      members: [
        member("mem_a", { lastSeenAt: NOW }),
        member("mem_b", { lastSeenAt: NOW }),
        member("mem_a", { lastSeenAt: NOW }),
      ],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual(["mem_a", "mem_b"]);
  });

  it("preserves the caller's member ordering for stable downstream output", () => {
    const result = activeMemberIds({
      members: [
        member("mem_c", { lastSeenAt: NOW }),
        member("mem_a", { lastSeenAt: NOW }),
        member("mem_b", { lastSeenAt: NOW }),
      ],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual(["mem_c", "mem_a", "mem_b"]);
  });

  it("accepts any iterable of connected ids (e.g. a Set from awareness)", () => {
    const result = activeMemberIds({
      members: [member("mem_a"), member("mem_b")],
      connectedIds: new Set(["mem_b"]),
      now: NOW,
    });
    expect(result).toEqual(["mem_b"]);
  });

  it("returns an empty quorum when nobody is connected or recently seen", () => {
    const result = activeMemberIds({
      members: [member("mem_a"), member("mem_b", { lastSeenAt: NOW - ACTIVE_WINDOW_MS * 2 })],
      connectedIds: [],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it("returns an empty quorum for an empty member list", () => {
    expect(activeMemberIds({ members: [], connectedIds: ["mem_ghost"], now: NOW })).toEqual([]);
  });

  it("a connection for an id with no member row adds nothing", () => {
    const result = activeMemberIds({
      members: [member("mem_a", { lastSeenAt: NOW })],
      connectedIds: ["mem_stranger"],
      now: NOW,
    });
    expect(result).toEqual(["mem_a"]);
  });
});
