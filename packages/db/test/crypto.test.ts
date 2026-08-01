import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, maskSecret } from "../src/crypto";

const KEY_ENV = "CREDENTIALS_ENCRYPTION_KEY";
const VALID_KEY = randomBytes(32).toString("base64");

const originalKey = process.env[KEY_ENV];

beforeEach(() => {
  process.env[KEY_ENV] = VALID_KEY;
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env[KEY_ENV];
  } else {
    process.env[KEY_ENV] = originalKey;
  }
});

describe("encryptSecret / decryptSecret", () => {
  it("roundtrips a secret", () => {
    const plain = "sk-live-abcdefghijklmnop1234";
    const encrypted = encryptSecret(plain);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it("roundtrips unicode and empty-ish secrets", () => {
    for (const plain of ["p@sswörd-δοκιμή-秘密", "x"]) {
      expect(decryptSecret(encryptSecret(plain))).toBe(plain);
    }
  });

  it("returns Buffers with GCM-shaped iv and tag, and no plaintext leakage", () => {
    const plain = "super-secret-credential";
    const { ciphertext, iv, tag } = encryptSecret(plain);
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(Buffer.isBuffer(iv)).toBe(true);
    expect(Buffer.isBuffer(tag)).toBe(true);
    expect(iv.length).toBe(12);
    expect(tag.length).toBe(16);
    expect(ciphertext.toString("utf8")).not.toContain(plain);
  });

  it("uses a fresh IV per call — same plaintext never encrypts identically", () => {
    const a = encryptSecret("same-secret");
    const b = encryptSecret("same-secret");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails on a tampered auth tag", () => {
    const encrypted = encryptSecret("do-not-tamper");
    const badTag = Buffer.from(encrypted.tag);
    badTag[0] = badTag[0]! ^ 0xff;
    expect(() => decryptSecret({ ...encrypted, tag: badTag })).toThrow();
  });

  it("fails on tampered ciphertext", () => {
    const encrypted = encryptSecret("do-not-tamper");
    const badCiphertext = Buffer.from(encrypted.ciphertext);
    badCiphertext[0] = badCiphertext[0]! ^ 0xff;
    expect(() => decryptSecret({ ...encrypted, ciphertext: badCiphertext })).toThrow();
  });

  it("fails when decrypting with a different key", () => {
    const encrypted = encryptSecret("locked-to-one-key");
    process.env[KEY_ENV] = randomBytes(32).toString("base64");
    expect(() => decryptSecret(encrypted)).toThrow();
  });
});

describe("key validation", () => {
  it("throws a clear error when the key env var is unset", () => {
    delete process.env[KEY_ENV];
    expect(() => encryptSecret("anything")).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("rejects keys that are not exactly 32 bytes", () => {
    for (const bytes of [16, 31, 33, 64]) {
      process.env[KEY_ENV] = randomBytes(bytes).toString("base64");
      expect(() => encryptSecret("anything")).toThrow(/32 bytes/);
    }
  });

  it("rejects garbage that does not decode to 32 bytes", () => {
    process.env[KEY_ENV] = "definitely-not-a-key";
    expect(() => encryptSecret("anything")).toThrow(/32 bytes/);
  });

  it("key-length errors never include the key material itself", () => {
    const badKey = randomBytes(16).toString("base64");
    process.env[KEY_ENV] = badKey;
    try {
      encryptSecret("anything");
      expect.unreachable("encryptSecret should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain(badKey);
    }
  });
});

describe("maskSecret", () => {
  it('masks to "…" + last 4 chars', () => {
    expect(maskSecret("sk-live-abcdef1234")).toBe("…1234");
    expect(maskSecret("whsec_9f8e7d6c5b4a")).toBe("…5b4a");
  });

  it("never reveals more than 4 characters of the secret", () => {
    for (const plain of ["sk-live-abcdefghij", "abcd", "abc", "a", ""]) {
      const masked = maskSecret(plain);
      const revealed = masked.replace("…", "");
      expect(revealed.length).toBeLessThanOrEqual(4);
      expect(plain.endsWith(revealed)).toBe(true);
      if (plain.length > 4) {
        expect(masked).not.toContain(plain);
      }
    }
  });
});
