#!/usr/bin/env python3
"""Open a LibreOffice Calc window and finish an OSWorld-style workbook.

The CSV stays on the Desktop. Calc shows the source rows, then this process
fills formulas, a summary sheet, number formats, and a frozen header on the
real X display. The saved ODS is posted to the fixture artifact route.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
import urllib.request
import zipfile
from pathlib import Path


def log(message: str) -> None:
    print(message, flush=True)


def status(text: str) -> None:
    Path("/tmp/osworld-status").write_text(text + "\n")


def wait_for_display() -> None:
    env = os.environ.copy()
    env["DISPLAY"] = ":0"
    for _ in range(90):
        if subprocess.call(["xdpyinfo"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            return
        time.sleep(1)
    raise SystemExit("X display :0 did not come up")


def hide_cursor() -> None:
    subprocess.Popen(
        [
            "python3",
            "-c",
            """
import ctypes, time
x11 = ctypes.CDLL("libX11.so.6")
xf = ctypes.CDLL("libXfixes.so.3")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XFlush.argtypes = [ctypes.c_void_p]
xf.XFixesQueryExtension.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
xf.XFixesHideCursor.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
ev, err = ctypes.c_int(), ctypes.c_int()
xf.XFixesQueryExtension(d, ctypes.byref(ev), ctypes.byref(err))
xf.XFixesHideCursor(d, x11.XDefaultRootWindow(d))
x11.XFlush(d)
while True:
    time.sleep(3600)
""",
        ],
        env={**os.environ, "DISPLAY": ":0"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def lo_formula(formula: str) -> str:
    """LibreOffice on this image parses argument separators as semicolons, and
    cross-sheet ranges must repeat the sheet on both ends or SUMIF returns Err:508."""
    import re

    expanded = re.sub(
        r'([A-Za-z][A-Za-z0-9]*)\.([A-Z]+\d+):([A-Z]+\d+)',
        lambda match: f"{match.group(1)}.{match.group(2)}:{match.group(1)}.{match.group(3)}",
        formula,
    )
    return expanded.replace(",", ";")


def col_index(letter: str) -> int:
    number = 0
    for char in letter.strip().upper():
        if not ("A" <= char <= "Z"):
            break
        number = number * 26 + (ord(char) - 64)
    return number - 1


def split_cell(ref: str) -> tuple[int, int]:
    column = ""
    row = ""
    for char in ref.strip():
        if char.isalpha():
            column += char
        elif char.isdigit():
            row += char
    if not column or not row:
        raise ValueError(f"bad cell {ref}")
    return col_index(column), int(row) - 1


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_starter_ods(path: Path, rows: list[list[str]]) -> None:
    body_rows = []
    for row in rows:
        cells = []
        for value in row:
            if value != "" and _is_number(value):
                cells.append(
                    f'<table:table-cell office:value-type="float" office:value="{value}"><text:p>{xml_escape(value)}</text:p></table:table-cell>'
                )
            else:
                cells.append(
                    f'<table:table-cell office:value-type="string"><text:p>{xml_escape(value)}</text:p></table:table-cell>'
                )
        body_rows.append("<table:table-row>" + "".join(cells) + "</table:table-row>")
    content = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:body><office:spreadsheet>
<table:table table:name="Sheet1">{''.join(body_rows)}</table:table>
</office:spreadsheet></office:body></office:document-content>
"""
    styles = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"></office:document-styles>
"""
    meta = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"></office:document-meta>
"""
    manifest = """<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        archive.writestr(info, "application/vnd.oasis.opendocument.spreadsheet")
        archive.writestr("content.xml", content)
        archive.writestr("styles.xml", styles)
        archive.writestr("meta.xml", meta)
        archive.writestr("META-INF/manifest.xml", manifest)


def _is_number(value: str) -> bool:
    try:
        float(value)
    except ValueError:
        return False
    return True


def prop(name: str, value: object):
    import uno

    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name = name
    item.Value = value
    return item


def number_format(doc, code: str) -> int:
    import uno

    locale = uno.createUnoStruct("com.sun.star.lang.Locale")
    locale.Language = "en"
    locale.Country = "US"
    formats = doc.NumberFormats
    key = formats.queryKey(code, locale, True)
    if key == -1:
        key = formats.addNew(code, locale)
    return int(key)


def connect(port: int):
    import uno

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    url = f"uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext"
    last: Exception | None = None
    for attempt in range(90):
        try:
            context = resolver.resolve(url)
            desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
            return desktop
        except Exception as exc:  # soffice is still painting the first window
            last = exc
            time.sleep(2)
    raise SystemExit(f"soffice socket not ready: {last}")


def launch_soffice(port: int) -> None:
    profile = Path.home() / ".config" / "libreoffice-osworld"
    for lock in profile.rglob(".lock"):
        try:
            lock.unlink()
        except IsADirectoryError:
            pass
    env = os.environ.copy()
    env["DISPLAY"] = ":0"
    env["LANG"] = "en_US.UTF-8"
    env["LC_ALL"] = "en_US.UTF-8"
    env["SAL_USE_VCLPLUGIN"] = "gen"
    env["UserInstallation"] = profile.as_uri()
    env["SAL_NO_JAVA"] = "1"
    subprocess.call(["pkill", "-f", "soffice.bin"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.6)
    log_handle = open("/tmp/soffice.log", "w")
    subprocess.Popen(
        [
            "soffice",
            "--calc",
            "--norestore",
            "--nologo",
            "--nodefault",
            "--nofirststartwizard",
            f"--accept=socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext",
        ],
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def place_window(doc) -> None:
    try:
        window = doc.getCurrentController().getFrame().getContainerWindow()
        window.setPosSize(0, 0, 1280, 800, 15)
        window.setVisible(True)
        window.setFocus()
    except Exception as exc:
        log(f"window resize skipped: {exc}")
    subprocess.call(
        "xdotool search --onlyvisible --class soffice windowsize 1280 760 windowmove 0 0 windowactivate || true",
        shell=True,
        env={**os.environ, "DISPLAY": ":0"},
    )


def show_range(controller, sheet, name: str) -> None:
    try:
        controller.setActiveSheet(sheet)
        controller.select(sheet.getCellRangeByName(name))
    except Exception as exc:
        log(f"select {name} skipped: {exc}")
    time.sleep(0.55)


def upload(url: str, path: Path) -> None:
    data = path.read_bytes()
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(request, timeout=60) as response:
        log(response.read().decode("utf-8", "replace"))


def solve(task: dict) -> None:
    import uno

    desktop_dir = Path.home() / "Desktop"
    desktop_dir.mkdir(parents=True, exist_ok=True)
    csv_path = desktop_dir / task["csv_name"]
    csv_path.write_text(task["csv"].strip() + "\n")
    rows = [line.split(",") for line in task["csv"].strip().splitlines() if line.strip()]
    starter = desktop_dir / task.get("starter_name", "source.ods")
    write_starter_ods(starter, rows)
    output = desktop_dir / task["ods_name"]

    color = task.get("desktop_color", "10243f")
    subprocess.call(["xsetroot", "-solid", f"#{color}"], env={**os.environ, "DISPLAY": ":0"})

    port = int(task.get("uno_port", 2002))
    launch_soffice(port)
    desktop = connect(port)
    doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(starter)), "_blank", 0, ())
    if doc is None:
        raise SystemExit(f"Calc did not open {starter}")
    place_window(doc)

    sheet = doc.getSheets().getByIndex(0)
    sheet.Name = task["sheet"]
    controller = doc.getCurrentController()
    try:
        doc.getCurrentController().getFrame().setTitle(task.get("window_title", task["id"]))
    except Exception:
        pass

    formats = {
        "currency": number_format(doc, "$#,##0.00"),
        "percent": number_format(doc, "0.00%"),
        "number": number_format(doc, "#,##0.00"),
    }
    data_rows = int(task["data_rows"])
    for spec in task.get("formats", []):
        index = col_index(spec["col"])
        fmt = formats.get(spec["format"])
        if fmt is None:
            continue
        for offset in range(data_rows):
            sheet.getCellByPosition(index, offset + 1).NumberFormat = fmt
        show_range(controller, sheet, f"{spec['col']}2:{spec['col']}{data_rows + 1}")

    for column in task["columns"]:
        index = col_index(column["col"])
        header = sheet.getCellByPosition(index, 0)
        header.setString(column["header"])
        header.CharWeight = 150
        fmt = formats.get(column.get("format", ""))
        for offset in range(data_rows):
            cell = sheet.getCellByPosition(index, offset + 1)
            cell.setFormula(lo_formula(column["formula"].format(row=offset + 2)))
            if fmt is not None:
                cell.NumberFormat = fmt
        show_range(controller, sheet, f"{column['col']}2:{column['col']}{data_rows + 1}")

    for index in range(8):
        cell = sheet.getCellByPosition(index, 0)
        if cell.getString():
            cell.CharWeight = 150

    grand = task.get("grand")
    if grand:
        label_col, label_row = split_cell(grand["label_cell"])
        sheet.getCellByPosition(label_col, label_row).setString(grand["label"])
        value_col, value_row = split_cell(grand["value_cell"])
        total = sheet.getCellByPosition(value_col, value_row)
        total.setFormula(lo_formula(grand["formula"]))
        grand_fmt = formats.get(grand.get("format", ""))
        if grand_fmt is not None:
            total.NumberFormat = grand_fmt
        show_range(controller, sheet, grand["value_cell"])

    summary_spec = task.get("summary")
    if summary_spec:
        sheets = doc.getSheets()
        name = summary_spec["sheet"]
        if not sheets.hasByName(name):
            sheets.insertNewByName(name, sheets.getCount())
        summary = sheets.getByName(name)
        for index, header in enumerate(summary_spec.get("headers", [])):
            cell = summary.getCellByPosition(index, 0)
            cell.setString(header)
            cell.CharWeight = 150
        fmt = formats.get(summary_spec.get("format", ""))
        for row_index, row in enumerate(summary_spec.get("rows", []), start=1):
            for letter, value in row.get("values", {}).items():
                summary.getCellByPosition(col_index(letter), row_index).setString(str(value))
            for letter, formula in row.get("formulas", {}).items():
                cell = summary.getCellByPosition(col_index(letter), row_index)
                cell.setFormula(lo_formula(formula))
                if fmt is not None and row.get("format", summary_spec.get("format")):
                    cell.NumberFormat = fmt
        controller.setActiveSheet(summary)
        time.sleep(0.8)
        controller.setActiveSheet(sheet)

    if task.get("freeze_header", True):
        controller.setActiveSheet(sheet)
        controller.freezeAtPosition(0, 1)

    note_col = col_index(task.get("note_column", "J"))
    note = sheet.getCellByPosition(note_col, 0)
    note.setString(task["goal"])
    note.CharWeight = 150
    note.IsTextWrapped = True
    try:
        sheet.getCellRangeByPosition(note_col, 0, note_col + 2, 8).merge(True)
        sheet.getColumns().getByIndex(note_col).Width = 11000
    except Exception as exc:
        log(f"note layout skipped: {exc}")

    try:
        doc.calculateAll()
    except Exception as exc:
        log(f"calculateAll skipped: {exc}")

    store = (
        prop("FilterName", "calc8"),
        prop("Overwrite", True),
    )
    doc.storeAsURL(uno.systemPathToFileUrl(str(output)), store)
    place_window(doc)
    controller.setActiveSheet(sheet)
    if task["columns"]:
        last = task["columns"][-1]["col"]
        show_range(controller, sheet, f"A1:{last}{data_rows + 1}")

    upload_url = task.get("upload_url")
    if not upload_url:
        base = os.environ.get("FIXTURES_URL", "http://10.0.2.2:4317").rstrip("/")
        upload_url = f"{base}/api/artifacts/{task['id']}"
    upload(upload_url, output)
    log(f"saved {output}")


def main() -> None:
    task_path = Path(sys.argv[1])
    task = json.loads(task_path.read_text())
    os.environ["DISPLAY"] = ":0"
    status("running")
    try:
        wait_for_display()
        hide_cursor()
        solve(task)
    except Exception:
        traceback.print_exc()
        status("fail")
        raise
    status("ok")


if __name__ == "__main__":
    main()
