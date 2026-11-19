"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { Workspace, WorkspaceOp } from "@/lib/workspace/types";

// The shared workspace with auto-save (BUILD-PROMPT §6): each edit is applied
// on screen at once, posted, and rolled back with the error if the write
// fails. A 30-s version check (and window focus) pulls other people's edits.

export const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

export type SaveState = { kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string };

export function useWorkspace(actor: string) {
  const ws = useSWR<Workspace>("/api/workspace", fetcher, { revalidateOnFocus: true });
  const ver = useSWR<{ version: number }>("/api/version", fetcher, { refreshInterval: 30_000, revalidateOnFocus: true });
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const myWrites = useRef(new Set<number>());

  // Someone else changed something: refresh, and say who.
  const seen = ws.data?.version;
  const latest = ver.data?.version;
  const { mutate } = ws;
  useEffect(() => {
    if (seen !== undefined && latest !== undefined && latest > seen) void mutate();
  }, [seen, latest, mutate]);
  const last = ws.data?.lastChange;
  const lastShown = useRef<number | null>(null);
  useEffect(() => {
    if (!last) return;
    if (lastShown.current === null) {
      lastShown.current = last.id; // what was there on first load isn't news
      return;
    }
    if (last.id > lastShown.current && !myWrites.current.has(last.id) && last.profile !== actor) {
      setNotice(`Updated by ${last.profile ?? "someone"} just now: ${last.summary}`);
    }
    lastShown.current = Math.max(lastShown.current, last.id);
  }, [last, actor]);

  const run = useCallback(
    async (op: WorkspaceOp, optimistic?: (w: Workspace) => Workspace) => {
      setSave({ kind: "saving" });
      try {
        const next = await mutate(
          async () => {
            const r = await fetch("/api/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...op, actor }) });
            const body = await r.json().catch(() => ({ error: `Save failed (${r.status}).` }));
            if (!r.ok) throw new Error(body.error ?? `Save failed (${r.status}).`);
            // Mark it as ours before the cache updates, so it doesn't show as someone else's edit.
            if (body.lastChange) myWrites.current.add(body.lastChange.id);
            return body as Workspace;
          },
          { optimisticData: optimistic ? (w) => optimistic(w!) : undefined, rollbackOnError: true, populateCache: true, revalidate: false }
        );
        setSave({ kind: "saved" });
        return next;
      } catch (e) {
        setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        return undefined;
      }
    },
    [mutate, actor]
  );

  return { ws: ws.data, error: ws.error, run, save, notice, clearNotice: () => setNotice(null), refresh: () => mutate() };
}
