"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { bandValue, computeBands, impliedPrice, metricRows, type Bands, type Period } from "@/lib/multiples/bands";
import { resultsDue, sectorMedian } from "@/lib/multiples/sector";
import { METRIC_LABELS, METRICS, type Basis, type Metric, type MultiplePoint } from "@/lib/multiples/types";
import { isMarketOpen } from "@/lib/market";
import type { CompactPoint, TabData } from "@/lib/stock-data";
import type { Workspace } from "@/lib/workspace/types";
import { BandChart, type ChartRow, type Marker } from "./BandChart";
import { DotsMenu, useDialogs, useReorder } from "./dialogs";
import { downloadWorkbook, exportCompany, peerExportRows } from "./exportExcel";
import { dayLabel, todayIst } from "./format";
import { PeerTable, type PeerRow, type PeerStat } from "./PeerTable";
import { SharesPanel } from "./SharesPanel";
import { Sidebar } from "./Sidebar";
import { fetcher, useWorkspace } from "./useWorkspace";

// The sector-tab page (BUILD-PROMPT §7). The URL holds profile / tab /
// company / basis / period so a view can be shared; the last-used profile is
// remembered per browser.

const PERIODS = [
  { key: "1Y", label: "1Y", months: 12 },
  { key: "2Y", label: "2Y", months: 24 },
  { key: "3Y", label: "3Y", months: 36 },
  { key: "5Y", label: "5Y", months: 60 },
  { key: "all", label: "Since Jan-21" },
  { key: "custom", label: "Custom" },
] as const;
const DEFAULT_PERIOD = "3Y";
const PROFILE_KEY = "im.profile";
const SOURCES = ["ace", "derived", "live"] as const;
const MEDIAN = "median";
const NO_IDS: number[] = [];

function decode(points: CompactPoint[]): MultiplePoint[] {
  return points.map(([date, pe, pbv, mcapSales, evEbitda, s]) => ({ date, pe, pbv, mcapSales, evEbitda, source: SOURCES[s] }));
}

function periodOf(key: string, from: string | null, to: string | null): Period {
  const p = PERIODS.find((x) => x.key === key);
  if (key === "all") return { kind: "all" };
  if (key === "custom" && from && to) return { kind: "custom", from, to };
  return { kind: "months", months: p && "months" in p ? p.months : 36 };
}

interface MetricView {
  rows: ChartRow[];
  bands: Bands;
}

function viewOf(points: MultiplePoint[], m: Metric, period: Period): MetricView | null {
  const rows = metricRows(points, m, period);
  const bands = computeBands(rows.map((r) => r.value));
  return bands ? { rows, bands } : null;
}

const statOf = (v: MetricView | null): PeerStat | null => (v ? { cur: v.bands.current, mean: v.bands.mean, z: v.bands.z, pct: v.bands.percentile } : null);

export function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const dlg = useDialogs();

  // ── URL state ──
  const set = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  const basis: Basis = params.get("b") === "S" ? "S" : "C";
  const periodKey = params.get("per") ?? DEFAULT_PERIOD;
  const period = periodOf(periodKey, params.get("from"), params.get("to"));
  const periodLabel = periodKey === "custom" && period.kind === "custom" ? `${dayLabel(period.from)} to ${dayLabel(period.to)}` : (PERIODS.find((p) => p.key === periodKey)?.label ?? "3Y");

  // This page renders in the browser only (below the Suspense boundary), so localStorage is safe here.
  const [remembered] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(PROFILE_KEY)) || null;
    } catch {
      return null;
    }
  });

  // The selected profile is "who" for every edit. Both hooks share SWR's cache for the workspace.
  const urlProfile = Number(params.get("p")) || null;
  const cached = useSWR<Workspace>("/api/workspace", fetcher).data;
  const pick = (w: Workspace | undefined) => w?.profiles.find((p) => p.id === urlProfile) ?? w?.profiles.find((p) => p.id === remembered) ?? w?.profiles[0] ?? null;
  const actor = pick(cached)?.name ?? "unknown";
  const { ws, error, run, save, notice, clearNotice, refresh } = useWorkspace(actor);
  const profile = pick(ws);
  useEffect(() => {
    if (!profile) return;
    try {
      localStorage.setItem(PROFILE_KEY, String(profile.id));
    } catch {}
  }, [profile]);
  const tab = profile?.tabs.find((t) => t.id === Number(params.get("t"))) ?? profile?.tabs[0] ?? null;
  const stockIds = tab?.stockIds ?? NO_IDS;
  const cParam = params.get("c");
  const company = cParam === MEDIAN && stockIds.length ? MEDIAN : (stockIds.find((id) => id === Number(cParam)) ?? stockIds[0] ?? null);

  // ── data ──
  const key = stockIds.length ? `/api/stocks-data?ids=${[...stockIds].sort((a, b) => a - b).join(",")}&basis=${basis}` : null;
  // Live prices: every 60 s in market hours, every 10 min otherwise (BUILD-PROMPT §5).
  const data = useSWR<TabData>(key, fetcher, { keepPreviousData: true, revalidateOnFocus: false, refreshInterval: () => (isMarketOpen() ? 60_000 : 600_000) });
  const byId = useMemo(() => new Map((data.data?.stocks ?? []).map((s) => [s.stockId, { s, points: decode(s.points) }])), [data.data]);
  const today = todayIst();

  const selected = company === MEDIAN ? null : company !== null ? byId.get(company) : undefined;
  const medianPoints = sectorMedian(stockIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!.points] : [])));
  const points = company === MEDIAN ? medianPoints : (selected?.points ?? []);
  const views = Object.fromEntries(METRICS.map((m) => [m, viewOf(points, m, period)])) as Record<Metric, MetricView | null>;

  const peer: PeerRow[] = stockIds.flatMap((id) => {
    const x = byId.get(id);
    if (!x) return [];
    const v = Object.fromEntries(METRICS.map((m) => [m, viewOf(x.points, m, period)])) as Record<Metric, MetricView | null>;
    const pe = v.pe;
    return [
      {
        key: String(id),
        name: x.s.name,
        fallback: x.s.fallback,
        resultsDue: resultsDue(x.s.lastAceDate, today),
        lastAceDate: x.s.lastAceDate,
        stats: Object.fromEntries(METRICS.map((m) => [m, statOf(v[m])])) as Record<Metric, PeerStat | null>,
        pePrices: [-1, 0, 1].map((k) => (pe ? impliedPrice("pe", bandValue(pe.bands, k), x.s.totals) : null)) as PeerRow["pePrices"],
      },
    ];
  });
  const medianRow: PeerRow | null = stockIds.length
    ? {
        key: MEDIAN,
        name: "Sector median",
        fallback: false,
        resultsDue: null,
        lastAceDate: null,
        stats: Object.fromEntries(METRICS.map((m) => [m, statOf(viewOf(medianPoints, m, period))])) as Record<Metric, PeerStat | null>,
        pePrices: [null, null, null],
      }
    : null;

  // ── ratio bar: jump to a chart, highlight the one in view ──
  const [inView, setInView] = useState<Metric>("pe");
  const sections = useRef<Partial<Record<Metric, HTMLElement | null>>>({});
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setInView(top.target.getAttribute("data-metric") as Metric);
      },
      { rootMargin: "-80px 0px -55% 0px" }
    );
    Object.values(sections.current).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [company, tab?.id, data.data]);

  // ── tabs and company chips ──
  const tabIds = profile?.tabs.map((t) => t.id) ?? [];
  const dragTab = useReorder(tabIds, (next) =>
    profile &&
    run({ op: "reorderTabs", profileId: profile.id, ids: next }, (w) => ({
      ...w,
      profiles: w.profiles.map((p) => (p.id === profile.id ? { ...p, tabs: next.map((id) => p.tabs.find((t) => t.id === id)!) } : p)),
    }))
  );
  const dragChip = useReorder(stockIds, (next) =>
    tab &&
    run({ op: "reorderStocks", tabId: tab.id, stockIds: next }, (w) => ({
      ...w,
      profiles: w.profiles.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tab.id ? { ...t, stockIds: next } : t)) })),
    }))
  );
  const stockName = (id: number) => ws?.stocks.find((s) => s.id === id)?.name ?? "…";
  const otherTabs = (ws?.profiles ?? []).flatMap((p) => p.tabs.filter((t) => t.id !== tab?.id).map((t) => ({ value: String(t.id), label: `${p.name} › ${t.name}` })));
  const profileOptions = (ws?.profiles ?? []).map((p) => ({ value: String(p.id), label: p.name }));

  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const matches = query.trim()
    ? (ws?.stocks ?? []).filter((s) => !stockIds.includes(s.id) && `${s.name} ${s.nseSymbol ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];

  if (error) return <div className="empty">Couldn&apos;t load the workspace: {String(error.message ?? error)}</div>;
  if (!ws) return <div className="empty">Loading…</div>;

  const addTab = async () => {
    if (!profile) return;
    const name = await dlg.prompt("New sector tab (e.g. Capital goods, Banks)", "", "Add tab");
    if (!name) return;
    const next = await run({ op: "addTab", profileId: profile.id, name });
    const made = next?.profiles.find((p) => p.id === profile.id)?.tabs.filter((t) => t.name === name).at(-1);
    if (made) set({ t: String(made.id), c: null });
  };
  const addStock = async (stockId: number) => {
    if (!tab) return;
    setQuery("");
    await run({ op: "addStock", tabId: tab.id, stockId }, (w) => ({
      ...w,
      profiles: w.profiles.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tab.id ? { ...t, stockIds: [...t.stockIds, stockId] } : t)) })),
    }));
  };
  const removeStock = async (id: number) => {
    if (!tab) return;
    if (!(await dlg.confirm(`Remove ${stockName(id)} from ${tab.name}?`, "It goes to Recently removed for 30 days. Its prices and Ace data stay in the app."))) return;
    run({ op: "removeStock", tabId: tab.id, stockId: id }, (w) => ({
      ...w,
      profiles: w.profiles.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tab.id ? { ...t, stockIds: t.stockIds.filter((x) => x !== id) } : t)) })),
    }));
  };

  const exportTab = async () => {
    if (!tab || !data.data) return;
    setExporting(true);
    try {
      const basisName = basis === "C" ? "Consolidated" : "Standalone";
      const companies = stockIds.flatMap((id) => {
        const x = byId.get(id);
        return x ? [exportCompany(x.s.name, x.s.fallback ? "Standalone (no consolidated figures)" : basisName, x.points, period, x.s)] : [];
      });
      const median = exportCompany("Sector median", basisName, medianPoints, period, null);
      const days = [...companies, median].flatMap((c) => c.rows.map((r) => r[0])).sort();
      await downloadWorkbook(
        { tab: tab.name, basis: basisName, periodLabel, from: days[0] ?? today, to: days.at(-1) ?? today, companies, median, peer: peerExportRows(peer, medianRow) },
        `${tab.name} multiples.xlsx`
      );
    } catch (e) {
      await dlg.confirm("The Excel export failed.", e instanceof Error ? e.message : String(e), "OK");
    } finally {
      setExporting(false);
    }
  };

  const stale = selected ? resultsDue(selected.s.lastAceDate, today) : null;
  const subject = company === MEDIAN ? `${tab?.name} · sector median` : (selected?.s.name ?? "");
  const basisLabel = (selected?.s.fallback ? "Standalone (no consolidated figures)" : basis === "C" ? "Consolidated" : "Standalone") + "";
  const markers = (m: Metric): Marker[] =>
    selected
      ? [
          ...selected.s.actions.map((a) => ({ date: a.date, label: { raise: "Raise", buyback: "Buyback", bonus: "Bonus", split: "Split", other: "Action" }[a.type] })),
          ...(m === "evEbitda" && selected.s.netDebt ? [{ date: selected.s.netDebt.asOf, label: "Net debt" }] : []),
        ]
      : [];

  return (
    <div className="shell">
      <Sidebar ws={ws} current={profile?.id ?? null} onPick={(id) => set({ p: String(id), t: null, c: null })} run={run} />
      <div className="main">
        <div className="strip">
          <span className="brand">India Multiples</span>
          {profile && (
            <div className="tabs" role="tablist">
              {profile.tabs.map((t) => {
                const d = dragTab(t.id);
                return (
                  <div key={t.id} {...d} role="tab" aria-selected={t.id === tab?.id} className={`tab${t.id === tab?.id ? " on" : ""} ${d.className ?? ""}`} onClick={() => set({ t: String(t.id), c: null })}>
                    {t.name}
                    <DotsMenu
                      className="dots tdots"
                      items={[
                        {
                          label: "Rename",
                          onClick: async () => {
                            const name = await dlg.prompt("Rename sector tab", t.name);
                            if (name && name !== t.name) run({ op: "renameTab", id: t.id, name });
                          },
                        },
                        { label: "Duplicate (with its companies)", onClick: () => run({ op: "duplicateTab", id: t.id }) },
                        ...(["Move", "Copy"] as const).map((verb) => ({
                          label: `${verb} to another profile…`,
                          onClick: async () => {
                            const to = await dlg.choose(`${verb} ${t.name} to which profile?`, profileOptions.filter((o) => verb === "Copy" || o.value !== String(profile.id)), verb);
                            if (to) run({ op: "moveTab", id: t.id, profileId: Number(to), copy: verb === "Copy" });
                          },
                        })),
                        {
                          label: "Remove",
                          danger: true,
                          onClick: async () => {
                            if (await dlg.confirm(`Remove ${t.name} from ${profile.name}?`, `Its ${t.stockIds.length} compan${t.stockIds.length === 1 ? "y" : "ies"} go to Recently removed with it for 30 days. Stock data is kept.`))
                              run({ op: "removeTab", id: t.id }, (w) => ({ ...w, profiles: w.profiles.map((p) => ({ ...p, tabs: p.tabs.filter((x) => x.id !== t.id) })) }));
                          },
                        },
                      ]}
                    />
                  </div>
                );
              })}
              <div className="tab add" role="button" tabIndex={0} onClick={addTab} onKeyDown={(e) => e.key === "Enter" && addTab()}>
                + Sector tab
              </div>
            </div>
          )}
          <span className={`saved${save.kind === "error" ? " bad" : ""}`} aria-live="polite">
            {save.kind === "saving" ? "Saving…" : save.kind === "error" ? `Not saved: ${save.message}` : "✓ Saved · shared with all users"}
          </span>
        </div>
        {notice && (
          <div className="note" style={{ display: "flex", gap: 8 }}>
            <span style={{ flex: 1 }}>{notice}</span>
            <button className="btn ghost" onClick={clearNotice}>
              OK
            </button>
          </div>
        )}

        {!profile ? (
          <div className="body">
            <div className="empty">No profiles yet. Use “+ New profile” in the sidebar to start.</div>
          </div>
        ) : !tab ? (
          <div className="body">
            <div className="empty">
              {profile.name} has no sector tabs yet. <button className="btn" onClick={addTab}>+ Sector tab</button>
            </div>
          </div>
        ) : (
          <>
            <div className="bar">
              <label className="fld">
                Company
                <select className="sel" value={company === null ? "" : String(company)} onChange={(e) => set({ c: e.target.value })} disabled={!stockIds.length}>
                  {stockIds.map((id) => (
                    <option key={id} value={id}>
                      {stockName(id)}
                    </option>
                  ))}
                  {stockIds.length > 0 && <option value={MEDIAN}>Sector median</option>}
                </select>
              </label>
              <div className="fld">
                Basis
                <div className="seg">
                  {(["C", "S"] as const).map((b) => (
                    <button key={b} className={basis === b ? "on" : undefined} onClick={() => set({ b: b === "C" ? null : "S" })}>
                      {b === "C" ? "Consolidated" : "Standalone"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="fld">
                Period
                <div className="seg">
                  {PERIODS.map((p) => (
                    <button
                      key={p.key}
                      className={periodKey === p.key ? "on" : undefined}
                      onClick={() => {
                        if (p.key !== "custom") return set({ per: p.key === DEFAULT_PERIOD ? null : p.key, from: null, to: null });
                        const to = selected?.s.points.at(-1)?.[0] ?? today;
                        set({ per: "custom", from: params.get("from") ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`, to: params.get("to") ?? to });
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {periodKey === "custom" && (
                <div className="fld">
                  From – to
                  <span style={{ display: "flex", gap: 4 }}>
                    <input type="date" className="sel" min="2021-01-01" value={params.get("from") ?? ""} onChange={(e) => e.target.value && set({ from: e.target.value })} />
                    <input type="date" className="sel" min="2021-01-01" value={params.get("to") ?? ""} onChange={(e) => e.target.value && set({ to: e.target.value })} />
                  </span>
                </div>
              )}
              <button className="btn" disabled={!data.data || exporting} onClick={exportTab} style={{ marginLeft: "auto" }}>
                {exporting ? "Building workbook…" : "Download Excel (whole tab)"}
              </button>
            </div>

            <div className="cobar">
              <span className="lbl">Companies in this tab</span>
              <div id="chips">
                {stockIds.map((id) => {
                  const d = dragChip(id);
                  return (
                    <span key={id} {...d} className={`chip${id === company ? " on" : ""} ${d.className ?? ""}`} onClick={() => set({ c: String(id) })}>
                      <span className="h" aria-hidden>
                        ⠿
                      </span>
                      {stockName(id)}
                      <DotsMenu
                        className="cdots"
                        items={(["Move", "Copy"] as const).map((verb) => ({
                          label: `${verb} to another tab…`,
                          onClick: async () => {
                            if (!otherTabs.length) return dlg.confirm("There's no other sector tab yet.", undefined, "OK");
                            const to = await dlg.choose(`${verb} ${stockName(id)} to which tab?`, otherTabs, verb);
                            if (to) run({ op: "moveStock", tabId: tab.id, stockId: id, toTabId: Number(to), copy: verb === "Copy" });
                          },
                        }))}
                      />
                      <button
                        className="cx"
                        aria-label={`Remove ${stockName(id)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeStock(id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
              <span style={{ position: "relative" }}>
                <input className="sel" placeholder="+ Add company: name or NSE symbol" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} aria-label="Add company" />
                {query.trim() && (
                  <div className="menu" style={{ top: "100%", left: 0, minWidth: 260 }}>
                    {matches.length ? (
                      matches.map((s) => (
                        <div key={s.id} onClick={() => addStock(s.id)}>
                          {s.name}
                          {s.nseSymbol ? <small style={{ color: "#6b7280" }}> · {s.nseSymbol}</small> : null}
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "#6b7280", cursor: "default" }}>No match among stocks with Ace data.</div>
                    )}
                  </div>
                )}
              </span>
            </div>

            {stockIds.length > 0 && (
              <div className="ratiobar">
                <span className="lbl">Jump to ratio</span>
                <div className="seg">
                  {METRICS.map((m) => (
                    <button key={m} className={inView === m ? "on" : undefined} onClick={() => sections.current[m]?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                      {METRIC_LABELS[m].short}
                    </button>
                  ))}
                </div>
                <span className="wide-only" style={{ color: "#686b72" }}>{subject}</span>
                <span className="wide-only" style={{ marginLeft: "auto", fontSize: 11, color: data.data?.live.error ? "#a56000" : "#686b72" }}>
                  {data.data?.live.error ? `Live prices off: ${data.data.live.error}` : data.data?.live.open ? "Market open · live prices every 60 s" : "Market closed"}
                </span>
              </div>
            )}

            <div className="body">
              {!stockIds.length ? (
                <div className="empty">No companies in {tab.name} yet. Add one with the search box above.</div>
              ) : !data.data ? (
                <div className="empty">{data.error ? `Couldn't load prices and multiples: ${data.error.message}` : "Loading multiples…"}</div>
              ) : (
                <>
                  {stale && selected && (
                    <p className="stale" style={{ margin: "0 0 10px" }}>
                      Results due — derived from {dayLabel(selected.s.anchor?.date ?? selected.s.lastAceDate!)} figures. Upload the back-dated Ace file after results.
                    </p>
                  )}
                  <div className="grid">
                    {METRICS.map((m) => {
                      const v = views[m];
                      const lender = m === "evEbitda" && selected && !selected.s.evMeaningful;
                      return (
                        <section key={m} className="panel" data-metric={m} ref={(el) => void (sections.current[m] = el)}>
                          <div className="band">
                            {METRIC_LABELS[m].long}
                            <small>
                              {subject} · {company === MEDIAN ? (basis === "C" ? "Consolidated" : "Standalone") : basisLabel} · mean ±1/±2 SD over {periodLabel}
                              {m === "pe" ? " · Mcap-based (diluted) PE after the last Ace day" : ""}
                            </small>
                            {v?.rows.at(-1)?.source === "live" && <span className="live">LIVE</span>}
                          </div>
                          {lender ? (
                            <div className="nm">n.m. — EV/EBITDA isn&apos;t meaningful for a lender (bank / NBFC / HFC / insurer): debt is its raw material, not financing.</div>
                          ) : v ? (
                            <BandChart
                              rows={v.rows}
                              bands={v.bands}
                              lastAceDate={company === MEDIAN ? null : (selected?.s.lastAceDate ?? null)}
                              markers={markers(m)}
                              priceAt={(x) => (company === MEDIAN ? null : impliedPrice(m, x, selected?.s.totals ?? null))}
                            />
                          ) : (
                            <div className="nm">n.m. — no {METRIC_LABELS[m].short} values in this period{company !== MEDIAN && basis === "C" ? " (try Standalone)" : ""}.</div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                  {selected && (
                    <SharesPanel
                      key={`${selected.s.stockId}-${basis}`}
                      s={selected.s}
                      basis={selected.s.basis}
                      actor={actor}
                      onChanged={() => {
                        void data.mutate();
                        refresh();
                      }}
                    />
                  )}
                  <h3 className="sec">
                    Peer table — {tab.name} · {basis === "C" ? "Consolidated" : "Standalone"} · {periodLabel}
                  </h3>
                  <section className="panel">
                    <PeerTable rows={peer} median={medianRow} />
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

