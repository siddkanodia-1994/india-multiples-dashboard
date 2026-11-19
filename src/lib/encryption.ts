import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

// AES-256-GCM for app settings at rest (the DHAN client ID and token).
// The key comes from SETTINGS_ENCRYPTION_KEY, which lives only in env vars.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

function getKey(): Buffer {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured — cannot encrypt/decrypt app settings.");
  return scryptSync(secret, "india-multiples-app-settings", 32);
}

export function encryptSetting(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptSetting(stored: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error("Setting is not encrypted.");
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv(ALGORITHM, getKey(), raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH)), decipher.final()]).toString("utf8");
}

export function maskExceptLast4(value: string): string {
  return value.length <= 4 ? "••••" : `${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}
