import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { newId } from "@quorum/shared/ids";

import { memberIdForUser, verifyBoardToken } from "../src/auth";

const SECRET = "test-secret-test-secret-test-secret!";
const NOW = 1_753_400_000_000;

const boardId = newId("board");
const userId = newId("user");

async function mintToken(overrides: {
  sub?: string;
  boardId?: string;
  role?: string;
  name?: string;
  color?: string;
  secret?: string;
  expiresInSec?: number;
  omitRole?: boolean;
}): Promise<string> {
  const claims: Record<string, unknown> = {
    boardId: overrides.boardId ?? boardId,
    name: overrides.name ?? "Dana",
    color: overrides.color ?? "#7c9cff",
  };
  if (!overrides.omitRole) claims.role = overrides.role ?? "editor";
  const key = new TextEncoder().encode(overrides.secret ?? SECRET);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? userId)
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(Math.floor(NOW / 1000) + (overrides.expiresInSec ?? 600))
    .sign(key);
}

describe("memberIdForUser", () => {
  it("maps usr_ → mem_ deterministically, preserving the id body", () => {
    expect(memberIdForUser("usr_V1StGXR8_Z5jdHi6")).toBe("mem_V1StGXR8_Z5jdHi6");
  });

  it("returns undefined for anything that is not a user id", () => {
    expect(memberIdForUser("agt_V1StGXR8_Z5jdHi6")).toBeUndefined();
    expect(memberIdForUser("usr_short")).toBeUndefined();
    expect(memberIdForUser("")).toBeUndefined();
  });
});

describe("verifyBoardToken", () => {
  it("accepts a valid token and builds the connection context", async () => {
    const token = await mintToken({});
    const ctx = await verifyBoardToken({ token, boardId, secret: SECRET, now: NOW });
    expect(ctx).toEqual({
      userId,
      memberId: memberIdForUser(userId),
      boardId,
      role: "editor",
      name: "Dana",
      color: "#7c9cff",
      readOnly: false,
    });
  });

  it("marks viewers readOnly", async () => {
    const token = await mintToken({ role: "viewer" });
    const ctx = await verifyBoardToken({ token, boardId, secret: SECRET, now: NOW });
    expect(ctx.readOnly).toBe(true);
    expect(ctx.role).toBe("viewer");
  });

  it("rejects a token minted for a different board", async () => {
    const token = await mintToken({ boardId: newId("board") });
    await expect(verifyBoardToken({ token, boardId, secret: SECRET, now: NOW })).rejects.toThrow(
      /different board/,
    );
  });

  it("rejects an expired token", async () => {
    const token = await mintToken({ expiresInSec: 60 });
    await expect(
      verifyBoardToken({ token, boardId, secret: SECRET, now: NOW + 120_000 }),
    ).rejects.toThrow();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await mintToken({ secret: "some-other-secret-entirely-here!!" });
    await expect(verifyBoardToken({ token, boardId, secret: SECRET, now: NOW })).rejects.toThrow();
  });

  it("rejects a token with malformed claims (missing role)", async () => {
    const token = await mintToken({ omitRole: true });
    await expect(verifyBoardToken({ token, boardId, secret: SECRET, now: NOW })).rejects.toThrow();
  });

  it("rejects garbage tokens", async () => {
    await expect(
      verifyBoardToken({ token: "not-a-jwt", boardId, secret: SECRET, now: NOW }),
    ).rejects.toThrow();
  });

  it("omits memberId for a sub that is not a usr_ id", async () => {
    const token = await mintToken({ sub: "service-account-1" });
    const ctx = await verifyBoardToken({ token, boardId, secret: SECRET, now: NOW });
    expect(ctx.userId).toBe("service-account-1");
    expect(ctx.memberId).toBeUndefined();
  });
});
