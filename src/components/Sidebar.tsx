"use client";

import { useState } from "react";
import type { Workspace, WorkspaceOp } from "@/lib/workspace/types";
import { DotsMenu, useDialogs, useReorder } from "./dialogs";
import { dayLabel } from "./format";

// Left sidebar (BUILD-PROMPT §6): every profile with a letter badge and tab
// count, a filter box, + New profile, and the Recently removed bin. On a phone
// it becomes a sideways-scrolling strip of names (CSS).

type Run = (op: WorkspaceOp, optimistic?: (w: Workspace) => Workspace) => Promise<Workspace | undefined>;

export function Sidebar({ ws, current, onPick, run }: { ws: Workspace; current: number | null; onPick: (id: number) => void; run: Run }) {
  const dlg = useDialogs();
  const [filter, setFilter] = useState("");
  const [showBin, setShowBin] = useState(false);
  const ids = ws.profiles.map((p) => p.id);
  const drag = useReorder(ids, (next) =>
    run({ op: "reorderProfiles", ids: next }, (w) => ({ ...w, profiles: next.map((id) => w.profiles.find((p) => p.id === id)!) }))
  );
  const shown = ws.profiles.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const addProfile = async () => {
    const name = await dlg.prompt("New profile", "", "Add profile");
    if (!name) return;
    const next = await run({ op: "addProfile", name });
    const made = next?.profiles.filter((p) => p.name === name).at(-1);
    if (made) onPick(made.id);
  };

  return (
    <aside className="sidebar">
      <h4>Profiles</h4>
      <input placeholder="Find a profile…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a profile" />
      {shown.map((p) => (
        <div key={p.id} {...drag(p.id)} className={`pro${p.id === current ? " on" : ""} ${drag(p.id).className ?? ""}`} onClick={() => onPick(p.id)}>
          <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            <span className="av">{p.name.slice(0, 1).toUpperCase()}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          </span>
          <span>
            <small>
              {p.tabs.length} tab{p.tabs.length === 1 ? "" : "s"}
            </small>
            <DotsMenu
              items={[
                {
                  label: "Rename",
                  onClick: async () => {
                    const name = await dlg.prompt("Rename profile", p.name);
                    if (name && name !== p.name) run({ op: "renameProfile", id: p.id, name }, (w) => ({ ...w, profiles: w.profiles.map((x) => (x.id === p.id ? { ...x, name } : x)) }));
                  },
                },
                { label: "Duplicate (with its tabs and companies)", onClick: () => run({ op: "duplicateProfile", id: p.id }) },
                {
                  label: "Remove",
                  danger: true,
                  onClick: async () => {
                    const n = p.tabs.length;
                    if (await dlg.confirm(`Remove profile ${p.name}?`, `Its ${n} sector tab${n === 1 ? "" : "s"} go to Recently removed with it, and can be restored for 30 days. Stock data is kept.`))
                      run({ op: "removeProfile", id: p.id }, (w) => ({ ...w, profiles: w.profiles.filter((x) => x.id !== p.id) }));
                  },
                },
              ]}
            />
          </span>
        </div>
      ))}
      <div className="newpro" role="button" tabIndex={0} onClick={addProfile} onKeyDown={(e) => e.key === "Enter" && addProfile()}>
        + New profile
      </div>

      <h4 style={{ marginTop: 18, cursor: "pointer" }} onClick={() => setShowBin((s) => !s)}>
        Recently removed ({ws.bin.length}) {showBin ? "▾" : "▸"}
      </h4>
      {showBin &&
        (ws.bin.length ? (
          ws.bin.map((b) => (
            <div className="binrow" key={b.binId}>
              <span>
                {{ profile: "Profile", tab: "Tab", company: "Company", action: "Action", netDebt: "Entry" }[b.kind]} <b>{b.label}</b>
                <small>
                  {b.from ? `from ${b.from} · ` : ""}
                  {b.removedBy ?? "someone"} · {dayLabel(b.removedAt.slice(0, 10))}
                </small>
              </span>
              <button onClick={() => run({ op: "restore", binId: b.binId })}>Restore</button>
            </div>
          ))
        ) : (
          <div className="binrow">
            <small>Nothing removed in the last 30 days.</small>
          </div>
        ))}
      <div className="side-foot">
        <a href="/admin" style={{ color: "#e5e7eb" }}>
          Admin
        </a>{" "}
        · uploads, DHAN, activity log
        <br />
        Everything here is shared with all users and saves as you go.
      </div>
    </aside>
  );
}
