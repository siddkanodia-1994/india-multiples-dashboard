import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { appSettings } from "../db/schema";
import { decryptSetting, encryptSetting, maskExceptLast4 } from "../encryption";

// One shared DHAN client ID + access token (BUILD-PROMPT §5), stored as a
// single encrypted value so the pair is always written in one statement.
// The token is write-only: nothing here ever returns it to a browser.

const KEY = "dhan";

export interface DhanCredentials {
  clientId: string;
  token: string;
}

export class DhanNotConfiguredError extends Error {
  constructor() {
    super("DHAN credentials are not set — add the client ID and access token on the Admin page.");
    this.name = "DhanNotConfiguredError";
  }
}

interface TokenClaims {
  /** When DHAN stops accepting the token. */
  expiresAt: Date | null;
  /** The DHAN client ID the token was issued to. */
  clientId: string | null;
}

/** DHAN access tokens are JWTs; reads their expiry and client ID without verifying the signature. */
export function tokenClaims(token: string): TokenClaims {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown; dhanClientId?: unknown };
    return {
      expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null,
      clientId: typeof payload.dhanClientId === "string" || typeof payload.dhanClientId === "number" ? String(payload.dhanClientId) : null,
    };
  } catch {
    return { expiresAt: null, clientId: null };
  }
}

export async function getDhanCredentials(): Promise<DhanCredentials> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY));
  if (!row) throw new DhanNotConfiguredError();
  return JSON.parse(decryptSetting(row.value)) as DhanCredentials;
}

export async function saveDhanCredentials(c: DhanCredentials): Promise<void> {
  const value = encryptSetting(JSON.stringify({ clientId: c.clientId, token: c.token }));
  await db
    .insert(appSettings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: sql`excluded.value`, updatedAt: new Date() } });
}

export interface DhanStatus {
  configured: boolean;
  /** Last 4 characters only. */
  clientId: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
}

/** For the Admin page: never the token, and only the last 4 of the client ID. */
export async function getDhanStatus(): Promise<DhanStatus> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY));
  if (!row) return { configured: false, clientId: null, updatedAt: null, expiresAt: null };
  const c = JSON.parse(decryptSetting(row.value)) as DhanCredentials;
  return { configured: true, clientId: maskExceptLast4(c.clientId), updatedAt: row.updatedAt.toISOString(), expiresAt: tokenClaims(c.token).expiresAt?.toISOString() ?? null };
}
