"""Excel export of one sector tab (BUILD-PROMPT §8), as a Vercel Python function.

The Next app computes every series and band exactly as the screen shows them
and POSTs them here as JSON; this builds the workbook with openpyxl:

* one sheet per company: its corporate actions and net-debt source, a data
  table (Date, Source, then for each metric: value, Mean, +1 SD, +2 SD,
  -1 SD, -2 SD) and four native, editable Excel line charts built from it;
* a "Sector median" sheet built the same way;
* a "Peer table" sheet.

Colours, dashes and legend order match the screen (BUILD-PROMPT §9). Run
`python3 api/export.py` for a local server on port 3010 (the Next dev server
forwards /api/export to it).
"""

import io
import json
import os
import re
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer

from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.axis import ChartLines, DateAxis
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.drawing.line import LineProperties
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

MAX_BODY = 8 * 1024 * 1024
EMU_PER_PX = 9525  # line widths are given in screen pixels, as in §9

METRICS = [
    ("pe", "TTM PE (x)"),
    ("pbv", "Price / Book (x)"),
    ("mcapSales", "Mcap / Sales (x)"),
    ("evEbitda", "EV / EBITDA (x)"),
]

# (label, hex colour, width px, dashed) in legend order — the same as the screen.
LINES = [
    ("Multiple", "1F2A5C", 2.2, False),
    ("Mean", "4B5563", 2.0, False),
    ("+1 SD", "E07B26", 1.6, True),
    ("+2 SD", "B22222", 1.6, True),
    ("-1 SD", "7CAD5B", 1.6, True),
    ("-2 SD", "2F4F2F", 1.6, True),
]
BAND_K = {"Mean": 0, "+1 SD": 1, "+2 SD": 2, "-1 SD": -1, "-2 SD": -2}
GRID = "EEF0F3"
RED = "B0101A"

TITLE = Font(bold=True, size=13)
BOLD = Font(bold=True)
HEAD_FILL = PatternFill("solid", fgColor="F3F4F6")
BAND_FILL = PatternFill("solid", fgColor=RED)
WHITE_BOLD = Font(bold=True, color="FFFFFF")
MULT_FMT = "0.00"
INR_FMT = "[$₹-4009]#,##,##0"


def day_label(iso):
    y, m, d = iso.split("-")
    return f"{d}-{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][int(m) - 1]}-{y[2:]}"


def sheet_name(name, used):
    base = re.sub(r"[\[\]:*?/\\]", " ", name).replace(" Ltd.", "").replace(" Limited", "").strip()[:28] or "Sheet"
    out, n = base, 2
    while out.lower() in used:
        out = f"{base[:25]} ({n})"
        n += 1
    used.add(out.lower())
    return out


def style_series(series, colour, width_px, dashed):
    series.graphicalProperties.line.solidFill = colour
    series.graphicalProperties.line.width = int(width_px * EMU_PER_PX)
    series.graphicalProperties.line.prstDash = "dash" if dashed else "solid"
    series.marker.symbol = "none"
    series.smooth = False


def company_sheet(wb, used, c, ctx):
    ws = wb.create_sheet(sheet_name(c["name"], used))
    ws.sheet_view.showGridLines = False
    ws["A1"] = c["name"]
    ws["A1"].font = TITLE
    ws["A2"] = f"{ctx['tab']} · {c.get('basisLabel', ctx['basis'])} · {ctx['periodLabel']} · mean ±1/±2 SD (sample SD, as STDEV.S)"
    r = 4
    ws.cell(r, 1, "Corporate actions").font = BOLD
    r += 1
    for a in c.get("actions") or ["None recorded."]:
        ws.cell(r, 1, a)
        r += 1
    r += 1
    ws.cell(r, 1, "Net debt for EV").font = BOLD
    ws.cell(r, 2, c.get("netDebt") or "")
    r += 2

    # Data table.
    header_row = r
    heads = ["Date", "Source"]
    for _, label in METRICS:
        short = label.split(" (")[0]
        heads += [short] + [f"{short} {x}" for x, *_ in LINES[1:]]
    for j, h in enumerate(heads, start=1):
        cell = ws.cell(header_row, j, h)
        cell.font = BOLD
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(wrap_text=True, horizontal="center")
    rows = c["rows"]
    bands = c.get("bands") or {}
    for i, row in enumerate(rows, start=header_row + 1):
        d, src = row[0], row[1]
        cell = ws.cell(i, 1, date.fromisoformat(d))
        cell.number_format = "dd-mmm-yy"
        ws.cell(i, 2, src)
        for m_idx, (key, _) in enumerate(METRICS):
            col = 3 + m_idx * 6
            v = row[2 + m_idx]
            b = bands.get(key)
            if v is not None:
                ws.cell(i, col, v).number_format = MULT_FMT
            if b:
                for k_idx, (lab, *_) in enumerate(LINES[1:], start=1):
                    ws.cell(i, col + k_idx, b["mean"] + BAND_K[lab] * b["sd"]).number_format = MULT_FMT
    last_row = header_row + len(rows)
    ws.column_dimensions["A"].width = 11
    ws.column_dimensions["B"].width = 8
    for j in range(3, len(heads) + 1):
        ws.column_dimensions[get_column_letter(j)].width = 9
    ws.freeze_panes = ws.cell(header_row + 1, 3)

    # Four native line charts, to the right of the table, one under another.
    anchor_col = get_column_letter(len(heads) + 2)
    for m_idx, (key, label) in enumerate(METRICS):
        anchor = f"{anchor_col}{header_row + m_idx * 22}"
        if not rows or not bands.get(key):
            ws[anchor] = f"{label}: n.m. — {c.get('nm', {}).get(key) or 'no values in this period'}"
            continue
        ws.add_chart(line_chart(ws, c["name"], label, ctx, c.get("basisLabel", ctx["basis"]), 3 + m_idx * 6, header_row, last_row), anchor)
    return ws


def line_chart(ws, company, label, ctx, basis_label, first_col, header_row, last_row):
    ch = LineChart()
    ch.title = f"{company} — {label} · {basis_label} · {day_label(ctx['from'])} to {day_label(ctx['to'])}"
    ch.height = 9.5
    ch.width = 26
    ch.legend.position = "b"
    ch.display_blanks = "gap"  # n.m. days are gaps, as on screen
    data = Reference(ws, min_col=first_col, max_col=first_col + 5, min_row=header_row, max_row=last_row)
    ch.add_data(data, titles_from_data=True)
    ch.set_categories(Reference(ws, min_col=1, min_row=header_row + 1, max_row=last_row))
    for s, (_, colour, width, dashed) in zip(ch.series, LINES):
        style_series(s, colour, width, dashed)
    ch.x_axis = DateAxis(crossAx=100)
    ch.x_axis.number_format = "mmm-yy"
    ch.x_axis.majorTimeUnit = "months"
    ch.x_axis.majorGridlines = None
    ch.x_axis.delete = False
    ch.y_axis.crossAx = 500
    ch.y_axis.number_format = "0.0"
    ch.y_axis.delete = False
    ch.y_axis.majorGridlines = ChartLines(spPr=GraphicalProperties(ln=LineProperties(solidFill=GRID)))
    return ch


def peer_sheet(wb, used, peer, ctx):
    ws = wb.create_sheet(sheet_name("Peer table", used))
    ws.sheet_view.showGridLines = False
    ws["A1"] = f"Peer table — {ctx['tab']} · {ctx['basis']} · {ctx['periodLabel']}"
    ws["A1"].font = TITLE
    groups = [("PE", 4), ("P/BV", 4), ("Mcap/Sales", 4), ("EV/EBITDA", 4), ("Price (PE)", 3)]
    col = 2
    for g, n in groups:
        ws.merge_cells(start_row=3, start_column=col, end_row=3, end_column=col + n - 1)
        cell = ws.cell(3, col, g)
        cell.font = WHITE_BOLD
        cell.fill = BAND_FILL
        cell.alignment = Alignment(horizontal="center")
        col += n
    subs = ["Company"] + ["Cur", "Mean", "z", "Pctl"] * 4 + ["@ -1 SD", "@ Mean", "@ +1 SD"]
    for j, h in enumerate(subs, start=1):
        cell = ws.cell(4, j, h)
        cell.font = BOLD
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal="center")
    fmts = ([MULT_FMT, MULT_FMT, "+0.00;-0.00;0.00", "0%"] * 4) + [INR_FMT] * 3
    for i, row in enumerate(peer, start=5):
        name = row["name"] + (" [S]" if row.get("fallback") else "") + (" — results due" if row.get("resultsDue") else "")
        ws.cell(i, 1, name).font = BOLD if row.get("median") else Font()
        for j, (v, f) in enumerate(zip(row["values"], fmts), start=2):
            if v is None:
                ws.cell(i, j, "n.m.").alignment = Alignment(horizontal="right")
                continue
            cell = ws.cell(i, j, v / 100 if f == "0%" else v)
            cell.number_format = f
            if row.get("median"):
                cell.font = BOLD
    ws.column_dimensions["A"].width = 34
    for j in range(2, len(subs) + 1):
        ws.column_dimensions[get_column_letter(j)].width = 10 if j < 18 else 12
    ws.freeze_panes = "B5"
    r = 6 + len(peer)
    ws.cell(r, 1, "[S] standalone figures (no consolidated) · Pctl: share of days in the period at or below today's value · n.m.: not meaningful").font = Font(italic=True, color="6B7280")
    return ws


def build_workbook(payload):
    ctx = {k: payload[k] for k in ("tab", "basis", "periodLabel", "from", "to")}
    wb = Workbook()
    wb.remove(wb.active)
    used = set()
    for c in payload["companies"]:
        company_sheet(wb, used, c, ctx)
    if payload.get("median"):
        company_sheet(wb, used, payload["median"], ctx)
    peer_sheet(wb, used, payload["peer"], ctx)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def file_name(payload):
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", f"{payload['tab']} multiples {payload['basis']} {payload['periodLabel']}").strip() or "multiples"
    return f"{safe}.xlsx"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._error(413, "Payload missing or too large.")
            payload = json.loads(self.rfile.read(n))
            if not isinstance(payload.get("companies"), list) or not payload["companies"]:
                return self._error(400, "No companies to export.")
            body = build_workbook(payload)
            # Local checks only: keep a copy of each workbook built (never set on Vercel).
            if os.environ.get("EXPORT_DEBUG_DIR"):
                with open(os.path.join(os.environ["EXPORT_DEBUG_DIR"], file_name(payload)), "wb") as f:
                    f.write(body)
        except (ValueError, KeyError, TypeError) as e:
            return self._error(400, f"Bad export request: {e}")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.send_header("Content-Disposition", f'attachment; filename="{file_name(payload)}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        body = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("Excel export on http://127.0.0.1:3010/api/export")
    HTTPServer(("127.0.0.1", 3010), handler).serve_forever()
