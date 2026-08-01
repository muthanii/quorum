/**
 * Credential encryption at rest — AES-256-GCM (CLAUDE.md §8).
 *
 * The key comes from CREDENTIALS_ENCRYPTION_KEY (base64, exactly 32 bytes)
 * and is read at call time so importing this module never requires env.
 * Nothing in this file logs, throws, or returns plaintext or key material —
 * keep it that way.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ENV = "CREDENTIALS_ENCRYPTION_KEY";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96-bit IV — the NIST-recommended size for GCM. */
const IV_BYTES = 12;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function getKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. Generate one with: openssl rand -base64 32 (see .env.example).`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${KEY_ENV} must be base64 for exactly ${KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
}

/** Encrypt a secret for storage. A fresh random IV per call — never reused. */
export function encryptSecret(plain: string): EncryptedSecret {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Decrypt a stored secret. Throws on any tampering (GCM auth failure) or on
 * a wrong key — the error carries no secret material.
 */
export function decryptSecret({ ciphertext, iv, tag }: EncryptedSecret): string {
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Display-safe mask: "…" + at most the last 4 characters. This is the ONLY
 * credential-derived value that may ever leave the server.
 */
export function maskSecret(plain: string): string {
  return `…${plain.slice(-4)}`;
}
