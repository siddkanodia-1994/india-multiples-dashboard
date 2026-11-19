"use client";

import { useState } from "react";
import type { ActionInput, StockOp } from "@/lib/stock-ops";
import type { StockData } from "@/lib/stock-data";
import { useDialogs } from "./dialogs";
import { crore, dayLabel, inr, todayIst } from "./format";

// "Shares & corporate actions — <company>" (BUILD-PROMPT §7): one list per
// stock, shared by every tab and profile. Base figures from the last Ace
// days, suggested actions to review, the action list with its add form, and
// the hand-entered net debt for EV with the EV/EBITDA switch.

const TYPE_LABEL = { raise: "Equity raise (QIP / preferential / rights)", buyback: "Buyback", bonus: "Bonus", split: "Split", other: "Other" } as const;
const SHORT = { raise: "Equity raise", buyback: "Buyback", bonus: "Bonus", split: "Split", other: "Other" } as const;
const CRORE = 1e7;

function details(a: StockData["actions"][number]): string {
  switch (a.type) {
    case "raise":
      return `${a.newShares.toFixed(4)} cr shares at ${inr(a.price, 2)} — +${crore(a.newShares * a.price)} to book value, −${crore(a.newShares * a.price)} net debt`;
    case "buyback":
      return `${a.shares.toFixed(4)} cr shares at ${inr(a.price, 2)} — −${crore(a.shares * a.price)} book value, +${crore(a.shares * a.price)} net debt`;
    case "bonus":
      return `${a.ratioA}:${a.ratioB} — shares × ${((a.ratioA + a.ratioB) / a.ratioB).toFixed(3)}, ratios unchanged`;
    case "split":
      return `Face value ₹${a.fvOld} → ₹${a.fvNew} — shares × ${(a.fvOld / a.fvNew).toFixed(3)}, ratios unchanged`;
    case "other":
      return `${a.sharesAfter.toFixed(4)} cr shares after${a.cash ? `, cash ${a.cash > 0 ? "in" : "out"} ${crore(Math.abs(a.cash))}` : ""}`;
  }
}

type Draft = { type: ActionInput["type"]; date: string; a: string; b: string; note: string; suggestionId?: number };

function suggestionText(s: StockData["suggestions"][number]): string {
  const d = s.detail;
  return s.kind === "price_drop"
    ? `The close fell from ${inr(Number(d.prevClose), 2)} to ${inr(Number(d.close), 2)} on ${dayLabel(s.date)} — about ${d.ratio}. A split or bonus?`
    : `Ace's share count moved ${Number(d.changePct).toFixed(1)}% on ${dayLabel(s.date)} (${Number(d.sharesBefore).toFixed(2)} → ${Number(d.sharesAfter).toFixed(2)} cr). A raise, buyback or other change?`;
}

function draftFrom(s: StockData["suggestions"][number]): Draft {
  const d = s.detail;
  if (s.kind === "price_drop") return { type: "split", date: s.date, a: String(Number(d.factor) * 1), b: "1", note: `Suggested: close fell ~${d.ratio}`, suggestionId: s.id };
  return { type: "other", date: s.date, a: String(Math.round(Number(d.sharesAfter) * CRORE)), b: "", note: "Suggested: Ace share count moved", suggestionId: s.id };
}

export function SharesPanel({ s, basis, actor, onChanged }: { s: StockData; basis: "C" | "S"; actor: string; onChanged: () => void }) {
  const dlg = useDialogs();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nd, setNd] = useState<{ asOf: string; debt: string; cash: string; minority: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const a = s.anchor;
  const t = s.totals;

  const send = async (op: StockOp) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/stock/${s.stockId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...op, actor }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Save failed (${r.status}).`);
      onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const n = (v: string) => Number(v.replace(/,/g, ""));
    const action: ActionInput =
      draft.type === "raise"
        ? { type: "raise", date: draft.date, newShares: n(draft.a) / CRORE, price: n(draft.b), note: draft.note }
        : draft.type === "buyback"
          ? { type: "buyback", date: draft.date, shares: n(draft.a) / CRORE, price: n(draft.b), note: draft.note }
          : draft.type === "bonus"
            ? { type: "bonus", date: draft.date, ratioA: n(draft.a), ratioB: n(draft.b), note: draft.note }
            : draft.type === "split"
              ? { type: "split", date: draft.date, fvOld: n(draft.a), fvNew: n(draft.b), note: draft.note }
              : { type: "other", date: draft.date, sharesAfter: n(draft.a) / CRORE, cash: draft.b.trim() ? n(draft.b) : null, note: draft.note };
    if (await send({ op: "addAction", action, suggestionId: draft.suggestionId })) setDraft(null);
  };

  const fieldLabels: Record<Draft["type"], [string, string]> = {
    raise: ["New shares (number)", "Issue price (₹)"],
    buyback: ["Shares bought back (number)", "Buyback price (₹)"],
    bonus: ["Bonus a (new shares)", "for every b held"],
    split: ["Old face value (₹)", "New face value (₹)"],
    other: ["Shares after (number)", "Cash in (+) / out (−), ₹ cr, optional"],
  };

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="band">
        Shares &amp; corporate actions — {s.name}
        <small>one list per stock, shared by every tab and profile · derived and live ratios on and after each date use the revised figures</small>
      </div>
      <div className="ca-body">
        {a ? (
          <div className="ca-kv">
            Base, from the last Ace days ({dayLabel(a.from)} – {dayLabel(a.date)}): shares <b>{a.shares.toFixed(2)} cr</b> · book value <b>{crore(a.bookValue)}</b>
            {t && (Math.abs(t.shares - a.shares) > 1e-9 || t.bookValue !== a.bookValue) && (
              <>
                {" "}
                · now, after actions: shares <b>{t.shares.toFixed(2)} cr</b> · book value <b>{crore(t.bookValue)}</b>
              </>
            )}
            {!s.hasPrices && <span className="stale"> · not matched to DHAN yet, so no daily or live prices (Admin)</span>}
          </div>
        ) : (
          <div className="ca-kv">No usable Ace close and Mcap yet, so nothing is held.</div>
        )}

        {s.suggestions.map((g) => (
          <div className="ca-sug" key={g.id}>
            <span>⚑ {suggestionText(g)}</span>
            <button className="btn" disabled={busy} onClick={() => setDraft(draftFrom(g))}>
              Review
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => send({ op: "dismissSuggestion", id: g.id })}>
              Not a corporate action
            </button>
          </div>
        ))}

        {s.actions.length ? (
          <table className="peer" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th style={{ textAlign: "left" }}>Details and effect</th>
                <th>Added by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.actions.map((x) => (
                <tr key={x.id}>
                  <td>{dayLabel(x.date)}</td>
                  <td>{SHORT[x.type]}</td>
                  <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                    {details(x)}
                    {x.note ? <small style={{ color: "#6b7280" }}> · {x.note}</small> : null}
                  </td>
                  <td>{x.createdBy}</td>
                  <td>
                    <button
                      className="btn ghost"
                      disabled={busy}
                      onClick={async () => {
                        if (await dlg.confirm(`Remove the ${SHORT[x.type].toLowerCase()} on ${dayLabel(x.date)} from ${s.name}?`, "It goes to Recently removed for 30 days."))
                          send({ op: "removeAction", id: x.id! });
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ca-kv" style={{ color: "#6b7280" }}>
            No corporate actions recorded.
          </div>
        )}

        {draft ? (
          <form
            className="ca-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveDraft();
            }}
          >
            <label className="fld">
              Type
              <select className="sel" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Draft["type"], a: "", b: "" })}>
                {(Object.keys(TYPE_LABEL) as Draft["type"][]).map((k) => (
                  <option key={k} value={k}>
                    {TYPE_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              Date (ex-date / allotment)
              <input className="sel" type="date" min="2021-01-01" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} required />
            </label>
            <label className="fld">
              {fieldLabels[draft.type][0]}
              <input className="sel" inputMode="decimal" value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} required />
            </label>
            <label className="fld">
              {fieldLabels[draft.type][1]}
              <input className="sel" inputMode="decimal" value={draft.b} onChange={(e) => setDraft({ ...draft, b: e.target.value })} required={draft.type !== "other"} />
            </label>
            <label className="fld" style={{ flex: 1, minWidth: 160 }}>
              Note
              <input className="sel" value={draft.note} maxLength={200} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </label>
            <button className="btn" disabled={busy}>
              Save action
            </button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setDraft({ type: "raise", date: todayIst(), a: "", b: "", note: "" })}>
            + Add corporate action
          </button>
        )}

        <div className="ndrow">
          <span className="src">
            <b>Net debt for EV ({basis === "C" ? "consolidated" : "standalone"}):</b>{" "}
            {s.netDebt ? (
              <>
                {crore(s.netDebt.value)} — entered by {s.netDebt.createdBy}, as of {dayLabel(s.netDebt.asOf)} (debt {crore(s.netDebt.debt)} − cash {crore(s.netDebt.cash)}
                {s.netDebt.minority ? ` + minority ${crore(s.netDebt.minority)}` : ""}){t?.netDebt !== null && t?.netDebt !== undefined && Math.abs(t.netDebt - s.netDebt.value) > 0.01 ? ` · now ${crore(t.netDebt)} after actions` : ""}{" "}
                <button
                  className="cdots"
                  disabled={busy}
                  onClick={async () => {
                    if (await dlg.confirm(`Remove the net-debt entry as of ${dayLabel(s.netDebt!.asOf)}?`, "Derived EV/EBITDA falls back to the previous entry, or n.m. It goes to Recently removed for 30 days."))
                      send({ op: "removeNetDebt", id: s.netDebt!.id });
                  }}
                >
                  remove
                </button>
              </>
            ) : (
              "not entered yet — derived and live EV/EBITDA show n.m. until it is (Ace's own history still shows)"
            )}
          </span>
          {!nd && (
            <button className="btn ghost" onClick={() => setNd({ asOf: todayIst(), debt: "", cash: "", minority: "" })}>
              + {s.netDebt ? "New entry" : "Enter net debt"} as of date
            </button>
          )}
          <label className="sw2">
            <input type="checkbox" checked={s.evMeaningful} disabled={busy} onChange={(e) => send({ op: "setEvMeaningful", value: e.target.checked })} />
            EV/EBITDA meaningful
          </label>
        </div>
        {nd && (
          <form
            className="ca-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const n = (v: string) => Number(v.replace(/,/g, "") || "0");
              if (await send({ op: "addNetDebt", basis, asOf: nd.asOf, debt: n(nd.debt), cash: n(nd.cash), minority: n(nd.minority) })) setNd(null);
            }}
          >
            <label className="fld">
              As of
              <input className="sel" type="date" min="2021-01-01" value={nd.asOf} onChange={(e) => setNd({ ...nd, asOf: e.target.value })} required />
            </label>
            {(["debt", "cash", "minority"] as const).map((k) => (
              <label className="fld" key={k}>
                {k === "debt" ? "Total debt (₹ cr)" : k === "cash" ? "Cash & equivalents (₹ cr)" : "Minority interest (₹ cr, optional)"}
                <input className="sel" inputMode="decimal" value={nd[k]} onChange={(e) => setNd({ ...nd, [k]: e.target.value })} required={k !== "minority"} />
              </label>
            ))}
            <button className="btn" disabled={busy}>
              Save net debt
            </button>
            <button type="button" className="btn ghost" onClick={() => setNd(null)}>
              Cancel
            </button>
          </form>
        )}
        {err && <p className="bad">{err}</p>}
      </div>
    </section>
  );
}
