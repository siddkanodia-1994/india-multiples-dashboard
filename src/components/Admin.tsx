"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import type { AceRow } from "@/lib/ace/parse";
import type { CompanyPreview } from "@/lib/ace/store";
import type { Workspace } from "@/lib/workspace/types";
import { useDialogs } from "./dialogs";
import { dayLabel } from "./format";
import { fetcher } from "./useWorkspace";

// The Admin page (BUILD-PROMPT §4, §5, §10): DHAN credentials, the Ace
// upload with its preview and batches, the Nifty 500 list and DHAN matching,
// closes sync, storage and the activity log. No password, by decision: the
// safeguards are the write-only token, confirm prompts, the log and rollback.

interface Status {
  dhan: { configured: boolean; clientId: string | null; updatedAt: string | null; expiresAt: string | null; error?: string };
  storage: { bytes: number; limit: number };
  batches: { id: number; kind: string; fileName: string; summary: { companies?: { name: string; added: number; changed: number }[]; rows?: number }; createdBy: string; createdAt: string; rolledBackAt: string | null; rolledBackBy: string | null }[];
  log: { id: number; at: string; profile: string | null; action: string; summary: string }[];
  sync: { status: string | null; cursor: { day: string; next: number; errors: string[] } | null; updatedAt: string | null } | null;
  universe: { id: number; name: string; accordCode: number | null; nseSymbol: string | null; isin: string | null; dhanSecurityId: number | null; industry: string | null; inNifty500: boolean; evMeaningful: boolean; lastAce: string | null; lastClose: string | null; closeDays: number }[];
  nifty500Rows: number;
}

interface Candidate {
  securityId: number;
  symbol: string;
  isin: string | null;
  name: string | null;
  score: number;
}

const PROFILE_KEY = "im.profile";
const CHUNK_ROWS = 5000;

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

async function readSheet(file: File): Promise<unknown[][]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
}

/** Rows grouped by company into request-sized chunks, a company never split. */
function chunksOf(rows: AceRow[]): AceRow[][] {
  const out: AceRow[][] = [];
  let cur: AceRow[] = [];
  let code: number | null = null;
  for (const r of rows) {
    if (r.accordCode !== code && cur.length >= CHUNK_ROWS) {
      out.push(cur);
      cur = [];
    }
    code = r.accordCode;
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="band">
        {title}
        {note && <small>{note}</small>}
      </div>
      <div className="ca-body">{children}</div>
    </section>
  );
}

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <p className={m.ok ? "ok" : "bad"} style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>{m.text}</p> : null;
}

export function Admin() {
  const dlg = useDialogs();
  const st = useSWR<Status>("/api/admin/status", fetcher);
  const ws = useSWR<Workspace>("/api/workspace", fetcher);
  // Read after hydration (the server has no localStorage), so both renders agree.
  const remembered = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return Number(localStorage.getItem(PROFILE_KEY)) || null;
      } catch {
        return null;
      }
    },
    () => null
  );
  const actor = ws.data?.profiles.find((p) => p.id === remembered)?.name ?? ws.data?.profiles[0]?.name ?? "unknown";
  const refresh = () => st.mutate();

  // ── DHAN ──
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [dhanMsg, setDhanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const saveDhan = async () => {
    setBusy("dhan");
    setDhanMsg(null);
    try {
      await post("/api/admin/dhan", { clientId, token, actor });
      setToken("");
      setDhanMsg({ ok: true, text: "Saved — DHAN answered a test quote." });
      refresh();
    } catch (e) {
      setDhanMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  // ── Ace upload ──
  const [ace, setAce] = useState<{ fileName: string; chunks: AceRow[][]; preview: CompanyPreview[]; errors: string[]; missing: string[]; mcapSource: string; hasLatestEv: boolean } | null>(null);
  const [aceMsg, setAceMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const pickAce = async (file: File) => {
    setAce(null);
    setAceMsg(null);
    setBusy("ace");
    try {
      const { parseAceRows } = await import("@/lib/ace/parse");
      const parsed = parseAceRows(await readSheet(file));
      if (!parsed.rows.length) throw new Error(parsed.errors.join(" ") || "No rows found.");
      const chunks = chunksOf(parsed.rows);
      const preview: CompanyPreview[] = [];
      for (let i = 0; i < chunks.length; i++) {
        setProgress(`Checking ${i + 1} of ${chunks.length} (about 5 s each)…`);
        preview.push(...(await post<{ companies: CompanyPreview[] }>("/api/admin/ace", { action: "preview", rows: chunks[i] })).companies);
      }
      setAce({ fileName: file.name, chunks, preview, errors: parsed.errors, missing: parsed.missing, mcapSource: parsed.mcapSource, hasLatestEv: parsed.hasLatestEv });
    } catch (e) {
      setAceMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };
  const saveAce = async () => {
    if (!ace) return;
    setBusy("ace");
    try {
      const { batchId } = await post<{ batchId: number }>("/api/admin/ace", { action: "begin", fileName: ace.fileName, actor });
      for (let i = 0; i < ace.chunks.length; i++) {
        setProgress(`Saving ${i + 1} of ${ace.chunks.length}…`);
        await post("/api/admin/ace", { action: "save", batchId, rows: ace.chunks[i], actor });
      }
      setProgress("Matching new companies to DHAN and back-filling their closes…");
      const done = await post<{ companies: { added: number; changed: number }[]; dhan: { matched: string[]; unmatched: string[]; backfilled: number; errors: string[] } }>("/api/admin/ace", {
        action: "finish",
        batchId,
        actor,
      });
      const d = done.dhan;
      setAceMsg({
        ok: !d.errors.length && !d.unmatched.length,
        text:
          `Saved as batch ${batchId}: ${done.companies.length} companies, ${done.companies.reduce((s, c) => s + c.added, 0)} new and ${done.companies.reduce((s, c) => s + c.changed, 0)} changed days.` +
          (d.matched.length ? `\nMatched to DHAN: ${d.matched.join(", ")}. Closes back-filled for ${d.backfilled}.` : "") +
          (d.unmatched.length ? `\nStill to match by hand (Pick… below): ${d.unmatched.join(", ")}.` : "") +
          (d.errors.length ? `\n${d.errors.join("\n")}` : ""),
      });
      setAce(null);
      refresh();
    } catch (e) {
      setAceMsg({ ok: false, text: `Stopped: ${e instanceof Error ? e.message : String(e)}. Anything saved so far is in its batch and can be rolled back.` });
      refresh();
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };
  const latestAce = st.data?.batches.find((b) => b.kind === "ace" && !b.rolledBackAt);
  const rollback = async (b: Status["batches"][number]) => {
    const comps = b.summary.companies ?? [];
    const added = comps.reduce((s, c) => s + c.added, 0);
    const changed = comps.reduce((s, c) => s + c.changed, 0);
    if (!(await dlg.confirm(`Roll back Ace upload ${b.fileName}?`, `This deletes the ${added.toLocaleString("en-IN")} days it added and puts back the old values of the ${changed.toLocaleString("en-IN")} days it changed. Companies it brought in stay in the universe.`, "Roll back")))
      return;
    try {
      const r = await post<{ removed: number; restored: number }>("/api/admin/ace", { action: "rollback", batchId: b.id, actor });
      setAceMsg({ ok: true, text: `Rolled back: ${r.removed} days removed, ${r.restored} restored.` });
    } catch (e) {
      setAceMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    refresh();
  };

  // ── universe ──
  const [uniMsg, setUniMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [picking, setPicking] = useState<{ stockId: number; name: string; candidates: Candidate[]; q: string } | null>(null);
  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setUniMsg(null);
    try {
      setUniMsg({ ok: true, text: await fn() });
    } catch (e) {
      setUniMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const uploadNifty = (file: File) =>
    run("nifty", async () => {
      const { parseNifty500 } = await import("@/lib/universe/match");
      const { rows, errors } = parseNifty500(await readSheet(file));
      if (!rows.length) throw new Error(errors.join(" "));
      const r = await post<{ rows: number; stocksUpdated: number }>("/api/admin/nifty500", { rows, fileName: file.name, actor });
      return `Nifty 500 list saved: ${r.rows} companies${errors.length ? `, ${errors.length} rows skipped` : ""}. ${r.stocksUpdated} matched stocks picked up their industry.`;
    });
  const autoMatch = () =>
    run("match", async () => {
      const n = await post<{ scrips: number }>("/api/admin/match", { action: "refresh", actor });
      const r = await post<{ matched: string[]; unmatched: { name: string }[] }>("/api/admin/match", { action: "auto", actor });
      return `DHAN list refreshed (${n.scrips.toLocaleString("en-IN")} NSE equities). Matched: ${r.matched.join(", ") || "none"}. Still to pick: ${r.unmatched.map((u) => u.name).join(", ") || "none"}. Use “Sync now” to back-fill closes for new matches.`;
    });
  const openPicker = async (s: Status["universe"][number]) => {
    const r = await post<{ candidates: Candidate[] }>("/api/admin/match", { action: "candidates", stockId: s.id });
    setPicking({ stockId: s.id, name: s.name, candidates: r.candidates, q: "" });
  };
  const apply = (c: Candidate) =>
    picking &&
    run("apply", async () => {
      const r = await post<{ backfill: string }>("/api/admin/match", { action: "apply", stockId: picking.stockId, securityId: c.securityId, actor });
      setPicking(null);
      return `${picking.name} → NSE ${c.symbol}. ${r.backfill}`;
    });

  // ── sync ──
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const syncNow = async () => {
    setBusy("sync");
    setSyncMsg(null);
    try {
      let restart = true;
      for (;;) {
        const r = await post<{ done: boolean; processed: number; total: number; errors: string[] }>("/api/admin/sync", { restart, actor });
        restart = false;
        setProgress(`Synced ${r.processed} of ${r.total} stocks…`);
        if (r.done) {
          setSyncMsg({ ok: !r.errors.length, text: `Done: ${r.total} stocks.${r.errors.length ? `\nErrors:\n${r.errors.join("\n")}` : ""}` });
          break;
        }
      }
    } catch (e) {
      setSyncMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setProgress(null);
      refresh();
    }
  };

  if (st.error) return <div className="empty">Couldn&apos;t load Admin: {String(st.error.message)}</div>;
  const s = st.data;
  const exp = s?.dhan.expiresAt ? new Date(s.dhan.expiresAt) : null;
  const hoursLeft = exp ? (exp.getTime() - Date.now()) / 3600_000 : null;
  const used = s ? s.storage.bytes / s.storage.limit : 0;

  return (
    <div className="main">
      <div className="strip">
        <span className="brand">India Multiples · Admin</span>
        <Link href="/" className="btn ghost" style={{ textDecoration: "none" }}>
          ← Dashboard
        </Link>
        <span className="saved">
          Acting as <b>{actor}</b>
        </span>
      </div>
      <div className="note">No password: anyone with this link can change the DHAN token or upload and roll back Ace data. Every change here is logged below.</div>
      <div className="body">
        {!s ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <Section title="DHAN market data" note="one shared client ID and token · the token is write-only and never shown again">
              <div className="ca-kv">
                {s.dhan.configured ? (
                  <>
                    Client ID <b>{s.dhan.clientId}</b> · saved {s.dhan.updatedAt ? new Date(s.dhan.updatedAt).toLocaleString("en-IN") : ""} ·{" "}
                    <span className={hoursLeft !== null && hoursLeft <= 0 ? "bad" : hoursLeft !== null && hoursLeft < 3 ? "stale" : "ok"}>
                      {exp ? (hoursLeft! <= 0 ? `token expired ${exp.toLocaleString("en-IN")}` : `token expires ${exp.toLocaleString("en-IN")}`) : "expiry unknown"}
                    </span>
                  </>
                ) : (
                  <span className="stale">Not set yet — live prices and closes need it.{s.dhan.error ? ` (${s.dhan.error})` : ""}</span>
                )}
              </div>
              <form
                className="ca-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveDhan();
                }}
              >
                <label className="fld">
                  Client ID
                  <input className="sel" value={clientId} onChange={(e) => setClientId(e.target.value)} inputMode="numeric" autoComplete="off" />
                </label>
                <label className="fld" style={{ flex: 1, minWidth: 260 }}>
                  Access token
                  <input className="sel" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
                </label>
                <button className="btn" disabled={busy === "dhan" || !clientId || !token}>
                  {busy === "dhan" ? "Testing…" : "Test and save"}
                </button>
              </form>
              <Msg m={dhanMsg} />
            </Section>

            <Section title="Daily closes" note="DHAN closes after each stock's last Ace day · the daily job runs at 7:05 PM IST">
              <div className="ca-kv">
                Last run: {s.sync?.updatedAt ? `${new Date(s.sync.updatedAt).toLocaleString("en-IN")} — ${s.sync.status}` : "never"}
                {s.sync?.cursor?.errors?.length ? <span className="bad"> · {s.sync.cursor.errors.length} errors</span> : null}
              </div>
              <button className="btn" onClick={syncNow} disabled={busy !== null}>
                {busy === "sync" ? progress ?? "Syncing…" : "Sync now"}
              </button>
              <Msg m={syncMsg} />
            </Section>

            <Section title="Ace Equity upload" note="the Query Expression export (.xlsx or .csv) · back-dated files replace derived days · licensed data, stored only here">
              <input type="file" accept=".xlsx,.xls,.csv" disabled={busy !== null} onChange={(e) => e.target.files?.[0] && pickAce(e.target.files[0])} />
              {busy === "ace" && <span style={{ marginLeft: 10 }}>{progress ?? "Reading the file…"}</span>}
              {ace && (
                <div style={{ marginTop: 12 }}>
                  <p className="stale" style={{ margin: "0 0 8px", fontWeight: 700 }}>
                    Preview only — nothing is saved until you press Save below.
                  </p>
                  {ace.missing.length > 0 && <p className="stale">Not in this file: {ace.missing.join(", ")}.</p>}
                  <p style={{ margin: "0 0 8px", color: "#4b5563" }}>
                    Daily Mcap: {ace.mcapSource === "ndp_mcap" ? "from NDP_Mcap" : "close × the Latest No of shares (no NDP_Mcap in this file, so share-count-jump alerts are skipped)"} · Net debt for EV:{" "}
                    {ace.hasLatestEv ? "set automatically from Latest EV − Latest Mcap" : "not in this file (no Latest EV)"} · New companies are matched to DHAN and back-filled after saving.
                  </p>
                  {ace.errors.length > 0 && <p className="bad">Skipped rows: {ace.errors.join(" · ")}</p>}
                  <div className="scroll">
                    <table className="peer">
                      <thead>
                        <tr>
                          <th>Company</th>
                          <th>Dates</th>
                          <th>New</th>
                          <th>Changed</th>
                          <th>Unchanged</th>
                          <th style={{ textAlign: "left" }}>Moves over 25% day-on-day (check)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ace.preview.map((c) => (
                          <tr key={c.accordCode}>
                            <td>
                              {c.name}
                              {c.stockId === null && <span className="badge">new</span>}
                            </td>
                            <td>
                              {dayLabel(c.from)} – {dayLabel(c.to)}
                            </td>
                            <td>{c.added}</td>
                            <td>{c.changed}</td>
                            <td>{c.unchanged}</td>
                            <td style={{ textAlign: "left", whiteSpace: "normal" }} className={c.spikes.length ? "stale" : undefined}>
                              {c.spikes.join(" · ") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button className="btn" onClick={saveAce} disabled={busy !== null}>
                      Save: {ace.preview.reduce((n, c) => n + c.added + c.changed, 0).toLocaleString("en-IN")} new or changed days
                      {ace.hasLatestEv ? ` + net debt for ${ace.preview.length} companies` : ""}
                    </button>
                    <button className="btn ghost" onClick={() => setAce(null)} disabled={busy !== null}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <Msg m={aceMsg} />
              <h3 className="sec">Upload batches</h3>
              <div className="scroll">
                <table className="peer">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Kind</th>
                      <th>File</th>
                      <th>By</th>
                      <th>When</th>
                      <th style={{ textAlign: "left" }}>What</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.batches.map((b) => (
                      <tr key={b.id} style={b.rolledBackAt ? { color: "#9ca3af" } : undefined}>
                        <td>{b.id}</td>
                        <td>{b.kind === "ace" ? "Ace" : "Nifty 500"}</td>
                        <td>{b.fileName}</td>
                        <td>{b.createdBy}</td>
                        <td>{new Date(b.createdAt).toLocaleString("en-IN")}</td>
                        <td style={{ textAlign: "left" }}>
                          {b.kind === "ace"
                            ? `${b.summary.companies?.length ?? 0} companies · ${(b.summary.companies ?? []).reduce((n, c) => n + c.added, 0)} new · ${(b.summary.companies ?? []).reduce((n, c) => n + c.changed, 0)} changed`
                            : `${b.summary.rows ?? 0} rows`}
                          {b.rolledBackAt && ` · rolled back by ${b.rolledBackBy}`}
                        </td>
                        <td>
                          {b.id === latestAce?.id && (
                            <button className="btn ghost" onClick={() => rollback(b)}>
                              Roll back
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title="Universe and DHAN matching" note="stocks join through Ace uploads · match each once to its NSE symbol and DHAN security ID">
              <div className="ca-form" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
                <label className="fld">
                  Nifty 500 list (NSE constituents .csv / .xlsx) — {s.nifty500Rows ? `${s.nifty500Rows} loaded` : "not loaded yet"}
                  <input type="file" accept=".csv,.xlsx,.xls" disabled={busy !== null} onChange={(e) => e.target.files?.[0] && uploadNifty(e.target.files[0])} />
                </label>
                <button className="btn" onClick={autoMatch} disabled={busy !== null}>
                  {busy === "match" ? "Matching…" : "Refresh DHAN list and auto-match"}
                </button>
              </div>
              <Msg m={uniMsg} />
              <div className="scroll" style={{ marginTop: 10 }}>
                <table className="peer">
                  <thead>
                    <tr>
                      <th>Company (Ace)</th>
                      <th>Accord</th>
                      <th>NSE</th>
                      <th>DHAN ID</th>
                      <th style={{ textAlign: "left" }}>Industry</th>
                      <th>EV/EBITDA</th>
                      <th>Last Ace</th>
                      <th>Last close</th>
                      <th>Closes</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.universe.map((u) => (
                      <tr key={u.id}>
                        <td>
                          {u.name}
                          {u.inNifty500 && <span className="badge">N500</span>}
                        </td>
                        <td>{u.accordCode ?? "—"}</td>
                        <td>{u.nseSymbol ?? "—"}</td>
                        <td>{u.dhanSecurityId ?? <span className="stale">not matched</span>}</td>
                        <td style={{ textAlign: "left" }}>{u.industry ?? "—"}</td>
                        <td>{u.evMeaningful ? "on" : "off"}</td>
                        <td>{u.lastAce ? dayLabel(u.lastAce) : "—"}</td>
                        <td>{u.lastClose ? dayLabel(u.lastClose) : "—"}</td>
                        <td>{u.closeDays}</td>
                        <td>
                          <button className="btn ghost" onClick={() => openPicker(u)} disabled={busy !== null}>
                            {u.dhanSecurityId ? "Change" : "Pick…"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {picking && (
                <div className="ca-sug" style={{ display: "block", marginTop: 12 }}>
                  <b>Match {picking.name}</b> to an NSE equity on DHAN:
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
                    {picking.candidates.map((c) => (
                      <button key={c.securityId} className="btn ghost" onClick={() => apply(c)} disabled={busy !== null}>
                        {c.symbol} · {c.name ?? ""} {c.score ? `(${Math.round(c.score * 100)}%)` : ""}
                      </button>
                    ))}
                    {!picking.candidates.length && <span>No close names — search below.</span>}
                  </div>
                  <input
                    className="sel"
                    placeholder="Search DHAN by symbol or name…"
                    value={picking.q}
                    onChange={async (e) => {
                      const q = e.target.value;
                      setPicking((p) => p && { ...p, q });
                      if (q.trim().length >= 2) {
                        const r = await post<{ candidates: Candidate[] }>("/api/admin/match", { action: "search", q });
                        setPicking((p) => (p && p.q === q ? { ...p, candidates: r.candidates } : p));
                      }
                    }}
                  />{" "}
                  <button className="btn ghost" onClick={() => setPicking(null)}>
                    Close
                  </button>
                  <p style={{ margin: "6px 0 0" }}>
                    Not on NSE (e.g. BSE-only)? Leave it unmatched: its Ace history still charts, but it gets no daily or live prices.
                  </p>
                </div>
              )}
            </Section>

            <Section title="Storage" note="Neon free tier · 0.5 GB">
              <div style={{ background: "#eef0f3", height: 12, borderRadius: 6, overflow: "hidden", maxWidth: 480 }}>
                <div style={{ width: `${Math.min(100, used * 100)}%`, height: "100%", background: used >= 0.8 ? "#b0101a" : "#1F2A5C" }} />
              </div>
              <div className="ca-kv" style={{ marginTop: 6 }}>
                {(s.storage.bytes / 1024 / 1024).toFixed(1)} MB of 512 MB ({(used * 100).toFixed(1)}%)
                {used >= 0.8 && <b className="bad"> — over 80%: plan for more space before it fills.</b>}
              </div>
            </Section>

            <Section title="Activity log" note="every add, remove, rename, reorder, duplicate, move, restore, purge, upload and setting change">
              <div className="scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
                <table className="peer">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Profile</th>
                      <th>Action</th>
                      <th style={{ textAlign: "left" }}>What</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.log.map((l) => (
                      <tr key={l.id}>
                        <td>{new Date(l.at).toLocaleString("en-IN")}</td>
                        <td>{l.profile ?? "—"}</td>
                        <td>{l.action}</td>
                        <td style={{ textAlign: "left", whiteSpace: "normal" }}>{l.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
