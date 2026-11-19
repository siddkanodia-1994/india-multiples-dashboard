"""Checks the Excel export (BUILD-PROMPT §8) on a made-up payload.

    python3 scripts/verify_export.py [out.xlsx]

Builds a workbook with api/export.py, re-opens it with openpyxl (sheets,
tables, number formats), and reads every chart's XML from the file to assert
the series order, colours, widths, dash styles, no markers, horizontal-only
gridlines and titles. openpyxl doesn't load charts back, hence the XML.
Made-up numbers only: real Ace values are licensed and never committed.
"""

import math
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
from export import LINES, build_workbook  # noqa: E402

from openpyxl import load_workbook  # noqa: E402

NS = {"c": "http://schemas.openxmlformats.org/drawingml/2006/chart", "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


def fake_company(name, n=60, base=20.0):
    rows = []
    for i in range(n):
        d = f"2026-{9 + i // 28:02d}-{1 + i % 28:02d}"
        wave = math.sin(i / 6)
        rows.append([d, "ace" if i < n - 3 else ("live" if i == n - 1 else "derived"), base + 3 * wave, 2 + 0.2 * wave, 3 + 0.3 * wave, None if i % 17 == 0 else 15 + wave])
    def band(k):
        vals = [r[k] for r in rows if r[k] is not None]
        mean = sum(vals) / len(vals)
        sd = (sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)) ** 0.5
        return {"mean": mean, "sd": sd}
    return {"name": name, "basisLabel": "Consolidated", "actions": ["01-Oct-26 · Bonus 1:1"], "netDebt": "₹1,200 cr — entered by Test, as of 30-Sep-26", "rows": rows, "bands": {"pe": band(2), "pbv": band(3), "mcapSales": band(4), "evEbitda": band(5)}}


def main(out):
    companies = [fake_company("Alpha Gears Ltd."), fake_company("Beta Engineering Ltd.", base=30.0)]
    median = fake_company("Sector median", base=25.0)
    median["bands"]["evEbitda"] = None
    median["nm"] = {"evEbitda": "fewer than two values"}
    peer = [{"name": c["name"], "values": [21.0, 20.0, 0.5, 60.0] * 4 + [900.0, 1000.0, 1100.0]} for c in companies]
    peer.append({"name": "Sector median", "median": True, "values": [25.0, 24.0, 0.4, 55.0] * 4 + [None, None, None]})
    payload = {"tab": "Test tab", "basis": "Consolidated", "periodLabel": "1Y", "from": "2025-11-19", "to": "2026-11-19", "companies": companies, "median": median, "peer": peer}
    data = build_workbook(payload)
    with open(out, "wb") as f:
        f.write(data)

    wb = load_workbook(out)
    assert wb.sheetnames == ["Alpha Gears", "Beta Engineering", "Sector median", "Peer table"], wb.sheetnames
    ws = wb["Alpha Gears"]
    header = next(r for r in range(1, 20) if ws.cell(r, 1).value == "Date")
    assert [ws.cell(header, j).value for j in range(3, 9)] == ["TTM PE", "TTM PE Mean", "TTM PE +1 SD", "TTM PE +2 SD", "TTM PE -1 SD", "TTM PE -2 SD"]
    assert ws.cell(header + 1, 3).number_format == "0.00"
    assert wb["Peer table"]["B5"].number_format == "0.00"

    z = zipfile.ZipFile(out)
    charts = sorted(n for n in z.namelist() if re.match(r"xl/charts/chart\d+\.xml", n))
    assert len(charts) == 2 * 4 + 3, f"expected 11 charts (4 + 4 + 3 for the median, EV n.m.), got {len(charts)}"
    for name in charts:
        root = ET.fromstring(z.read(name))
        title = "".join(t.text or "" for t in root.iter(f"{{{NS['a']}}}t"))
        assert re.search(r" — .+ \(x\) · Consolidated · 19-Nov-25 to 19-Nov-26$", title), title
        sers = root.findall(".//c:lineChart/c:ser", NS)
        assert len(sers) == 6, name
        for ser, (label, colour, width_px, dashed) in zip(sers, LINES):
            # Legend order: each series is named by its table header cell, Multiple first.
            ref = ser.find("c:tx/c:strRef/c:f", NS).text
            m = re.match(r"'?(.+?)'?!\$?([A-Z]+)\$?(\d+)$", ref)
            sheet, cell = m.group(1), m.group(2) + m.group(3)
            head = wb[sheet][cell].value
            assert (head.endswith(label) if label != "Multiple" else " " not in head.replace("TTM PE", "").replace("Price / Book", "").replace("Mcap / Sales", "").replace("EV / EBITDA", "").strip()), (name, label, head)
            ln = ser.find("c:spPr/a:ln", NS)
            assert ln.find("a:solidFill/a:srgbClr", NS).get("val") == colour, (name, label)
            assert int(ln.get("w")) == int(width_px * 9525), (name, label, ln.get("w"))
            assert ln.find("a:prstDash", NS).get("val") == ("dash" if dashed else "solid"), (name, label)
            assert ser.find("c:marker/c:symbol", NS).get("val") == "none", (name, label)
            assert ser.find("c:smooth", NS).get("val") in ("0", "false"), (name, label)
        assert root.find(".//c:dateAx/c:majorGridlines", NS) is None, "vertical gridlines present"
        grid = root.find(".//c:valAx/c:majorGridlines/c:spPr/a:ln/a:solidFill/a:srgbClr", NS)
        assert grid is not None and grid.get("val") == "EEF0F3", name
        assert root.find(".//c:dispBlanksAs", NS).get("val") == "gap", name
        # Layout: legend at the top with its own space, horizontal date labels, the screen's Y range.
        legend = root.find(".//c:legend", NS)
        assert legend.find("c:legendPos", NS).get("val") == "t", name
        assert legend.find("c:overlay", NS).get("val") in ("0", "false"), name
        assert root.find(".//c:dateAx/c:txPr/a:bodyPr", NS).get("rot") == "0", name
        assert int(root.find(".//c:dateAx/c:majorUnit", NS).get("val")) >= 1, name
        scaling = root.find(".//c:valAx/c:scaling", NS)
        assert scaling.find("c:min", NS) is not None and scaling.find("c:max", NS) is not None, name
    print(f"OK: {len(wb.sheetnames)} sheets, {len(charts)} charts checked — colours, widths, dashes, no markers, legend order, gridlines, titles. Saved {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "export-check.xlsx")
