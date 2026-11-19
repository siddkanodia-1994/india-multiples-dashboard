"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Small promise-based dialogs (confirm / name prompt / pick one) and the ⋯ menu.

type Dialog =
  | { kind: "confirm"; title: string; body?: string; ok: string; resolve: (v: boolean) => void }
  | { kind: "prompt"; title: string; value: string; ok: string; resolve: (v: string | null) => void }
  | { kind: "choose"; title: string; options: { value: string; label: string }[]; ok: string; resolve: (v: string | null) => void };

interface Api {
  confirm: (title: string, body?: string, ok?: string) => Promise<boolean>;
  prompt: (title: string, value?: string, ok?: string) => Promise<string | null>;
  choose: (title: string, options: { value: string; label: string }[], ok?: string) => Promise<string | null>;
}

const Ctx = createContext<Api | null>(null);

export function useDialogs(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error("useDialogs outside DialogHost");
  return api;
}

export function DialogHost({ children }: { children: ReactNode }) {
  const [d, setD] = useState<Dialog | null>(null);
  const [text, setText] = useState("");
  const confirm = useCallback<Api["confirm"]>((title, body, ok = "Remove") => new Promise((resolve) => setD({ kind: "confirm", title, body, ok, resolve })), []);
  const prompt = useCallback<Api["prompt"]>(
    (title, value = "", ok = "Save") =>
      new Promise((resolve) => {
        setText(value);
        setD({ kind: "prompt", title, value, ok, resolve });
      }),
    []
  );
  const choose = useCallback<Api["choose"]>(
    (title, options, ok = "OK") =>
      new Promise((resolve) => {
        setText(options[0]?.value ?? "");
        setD({ kind: "choose", title, options, ok, resolve });
      }),
    []
  );
  const close = (v: boolean | string | null) => {
    if (!d) return;
    if (d.kind === "confirm") d.resolve(Boolean(v));
    else d.resolve(typeof v === "string" ? v : null);
    setD(null);
  };
  const submit = () => (d?.kind === "confirm" ? close(true) : text.trim() ? close(text.trim()) : undefined);

  return (
    <Ctx.Provider value={{ confirm, prompt, choose }}>
      {children}
      {d && (
        <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && close(d.kind === "confirm" ? false : null)}>
          <form
            className="dlg"
            role="dialog"
            aria-label={d.title}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onKeyDown={(e) => e.key === "Escape" && close(d.kind === "confirm" ? false : null)}
          >
            <h5>{d.title}</h5>
            {d.kind === "confirm" && d.body && <p style={{ margin: 0, color: "#4b5563" }}>{d.body}</p>}
            {d.kind === "prompt" && <input className="sel" autoFocus value={text} maxLength={60} onChange={(e) => setText(e.target.value)} />}
            {d.kind === "choose" && (
              <select className="sel" autoFocus value={text} onChange={(e) => setText(e.target.value)}>
                {d.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            <div className="row">
              <button type="button" className="btn ghost" onClick={() => close(d.kind === "confirm" ? false : null)}>
                Cancel
              </button>
              <button type="submit" className={`btn${d.kind === "confirm" ? " danger" : ""}`} autoFocus={d.kind === "confirm"}>
                {d.ok}
              </button>
            </div>
          </form>
        </div>
      )}
    </Ctx.Provider>
  );
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

/** A ⋯ button that opens a small menu of actions. */
export function DotsMenu({ items, className = "dots", label = "More actions" }: { items: MenuItem[]; className?: string; label?: string }) {
  // Fixed to the viewport so a scrolling sidebar or chip row can't clip it.
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node) && setOpen(null);
    const close = () => setOpen(null);
    document.addEventListener("mousedown", off);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", off);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setOpen((o) => (o ? null : { top: r.bottom + 2, left: Math.min(r.left, window.innerWidth - 220) }));
        }}
      >
        ⋯
      </button>
      {open &&
        createPortal(
        <div ref={menuRef} className="menu" role="menu" style={{ position: "fixed", top: open.top, left: open.left }}>
          {items.map((it) => (
            <div
              key={it.label}
              role="menuitem"
              className={it.danger ? "danger" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(null);
                it.onClick();
              }}
            >
              {it.label}
            </div>
          ))}
        </div>,
          document.body
        )}
    </span>
  );
}

/** Drag-to-reorder for a list of ids: returns props for each draggable item. */
export function useReorder<T extends string | number>(ids: T[], onDrop: (next: T[]) => void) {
  const [dragging, setDragging] = useState<T | null>(null);
  const [over, setOver] = useState<T | null>(null);
  return (id: T) => ({
    draggable: true,
    className: over === id && dragging !== id ? "drag-over" : undefined,
    onDragStart: (e: React.DragEvent) => {
      setDragging(id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: React.DragEvent) => {
      if (dragging === null) return;
      e.preventDefault();
      setOver(id);
    },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragging !== null && dragging !== id) {
        // Takes the target's place: lands after it when dragged down, before it when dragged up.
        const next = ids.filter((x) => x !== dragging);
        next.splice(ids.indexOf(id), 0, dragging);
        onDrop(next);
      }
      setDragging(null);
      setOver(null);
    },
  });
}
