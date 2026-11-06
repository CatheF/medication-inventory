"""Independent oracle for the order-sheet workbook (used by tests/e2e/print-and-export.spec.ts).

Run as:  python3 -I print-export-inspect-xlsx.py <file.xlsx>
Prints one JSON document on stdout. It deliberately uses nothing from the application: only the standard library
(zipfile / xml) and openpyxl, so a mistake in the app's own workbook writer cannot also hide in the checker.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

import openpyxl

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def json_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return {"__repr__": repr(value), "__iso__": value.isoformat() if hasattr(value, "isoformat") else None}


def raw_cells(archive, sheet_paths):
    """Cell types and formula presence straight from the sheet XML (not through openpyxl's interpretation)."""
    found = []
    for path in sheet_paths:
        root = ET.fromstring(archive.read(path))
        for c in root.iter("{%s}c" % NS["m"]):
            found.append(
                {
                    "sheet": path,
                    "ref": c.get("r"),
                    "t": c.get("t"),
                    "hasFormula": c.find("m:f", NS) is not None,
                }
            )
    return found


def main(path):
    out = {}
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        out["zipEntries"] = names
        sheet_paths = sorted(n for n in names if re.match(r"^xl/worksheets/[^/]+\.xml$", n))
        out["sheetXmlCount"] = len(sheet_paths)
        cells = raw_cells(archive, sheet_paths)
        out["rawFormulaCells"] = [c["ref"] for c in cells if c["hasFormula"]]
        out["rawCellTypes"] = {c["ref"]: c["t"] for c in cells}
        # any formula tag anywhere in any sheet part, even one the cell walk did not reach
        out["formulaTagCount"] = sum(len(re.findall(rb"<(?:\w+:)?f[\s>/]", archive.read(p))) for p in sheet_paths)

    wb = openpyxl.load_workbook(path)  # data_only=False: a formula cell would show up as data_type "f"
    out["sheetNames"] = wb.sheetnames
    ws = wb.worksheets[0]
    out["freezePanes"] = ws.freeze_panes
    out["maxRow"] = ws.max_row
    out["maxCol"] = ws.max_column
    out["printTitleRows"] = ws.print_title_rows
    out["orientation"] = ws.page_setup.orientation
    out["fitToWidth"] = ws.page_setup.fitToWidth
    out["fitToHeight"] = ws.page_setup.fitToHeight
    out["fitToPage"] = bool(ws.sheet_properties.pageSetUpPr and ws.sheet_properties.pageSetUpPr.fitToPage)
    out["columnWidths"] = {k: v.width for k, v in ws.column_dimensions.items()}

    grid = []
    flat = []
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=1, max_col=ws.max_column):
        grid_row = []
        for c in row:
            entry = {
                "ref": c.coordinate,
                "row": c.row,
                "col": c.column,
                "value": json_value(c.value),
                "type": c.data_type,  # n numeric, s string, f formula, b bool, d date, e error
                "format": c.number_format,
                "bold": bool(c.font is not None and c.font.b),
                "wrap": bool(c.alignment is not None and c.alignment.wrap_text),
            }
            grid_row.append(entry)
            flat.append(entry)
        grid.append(grid_row)
    out["cells"] = flat
    out["formulaCells"] = [e["ref"] for e in flat if e["type"] == "f"]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write("usage: print-export-inspect-xlsx.py <file.xlsx>\n")
        sys.exit(2)
    main(sys.argv[1])
