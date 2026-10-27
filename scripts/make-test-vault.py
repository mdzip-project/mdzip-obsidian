#!/usr/bin/env python3
"""Build (or reset) an Obsidian test vault for the MDZip plugin.

    python scripts/make-test-vault.py [TARGET] [--force]

TARGET defaults to ../TestVault (next to this repo). The vault holds
interlinked Markdown notes, several .mdz archives (document and project mode,
no manifest, Unicode names, a large one, broken ones), a PDF, images, CSV,
JSON and a canvas, plus a "Test Plan.md" checklist.

The plugin folder is linked to this repo (a junction on Windows, a symlink
elsewhere), so `npm run build` / `npm run dev` take effect after reloading the
plugin in Obsidian.

--force rebuilds an existing test vault. It only ever deletes a folder that
contains the marker file written by this script, and it keeps the vault's
.obsidian folder (workspace, settings), so an existing Obsidian setup survives.

The archives are written with mdzip-core-python (../mdzip-core-python/src).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKSPACE = REPO.parent
sys.path.insert(0, str(WORKSPACE / "mdzip-core-python" / "src"))
import mdzip_core  # noqa: E402

MARKER = ".mdzip-test-vault"


# ---- Binary helpers -------------------------------------------------------


def png(width: int, height: int, color: tuple, accent: tuple) -> bytes:
    """A small PNG: a solid background with a diagonal accent stripe."""
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            row += bytes(accent if abs(x - y * width // height) < max(2, width // 12) else color)
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def svg(label: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">'
        '<rect width="240" height="120" rx="10" fill="#222"/>'
        '<circle cx="40" cy="60" r="22" fill="#888"/>'
        f'<text x="76" y="68" font-family="sans-serif" font-size="18" fill="#eee">{label}</text></svg>\n'
    )


def pdf(pages: list) -> bytes:
    """A valid multi-page PDF with real text (Helvetica), built by hand."""
    objects = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id = len(objects) + 1 + len(pages) * 2  # filled in below
    page_ids = []
    for lines in pages:
        text = b"BT /F1 14 Tf 72 740 Td 18 TL " + b" ".join(
            b"(" + line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("latin-1") + b") '"
            for line in lines
        ) + b" ET"
        content = add(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
        page_ids.append(
            add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                % (pages_id, font, content)
            )
        )
    assert add(b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % p for p in page_ids), len(page_ids))) == pages_id
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, catalog, xref)
    return bytes(out)


# ---- Vault content --------------------------------------------------------

GREY, DARK, LIGHT, RED, BLUE = (136, 136, 136), (34, 34, 34), (230, 230, 230), (200, 60, 60), (60, 110, 200)


def notes() -> dict:
    return {
        "Home.md": """---
tags: [moc, test]
aliases: [Start here]
---
# Home

Welcome to the MDZip test vault. Start with [[Test Plan]].

## Notes
- [[Ada Lovelace]] and [[Grace Hopper]] (people)
- [[Zettelkasten]], [[Linking#Heading links|heading links]], [[Linking#^key-idea|a block reference]]
- [[Project Alpha]] and the daily notes [[2026-10-10]], [[2026-10-11]]
- A link to a note that doesn't exist yet: [[Unwritten Idea]]

## Archives (.mdz)
- [Field Guide](Archives/Field%20Guide.mdz) — single document with images
- [[Projects/Alpha Handbook.mdz|Alpha Handbook]] — project with several documents
- [Recipes](Recipes.mdz) — no manifest; README and AGENTS support files
- [Café Notes](<Archives/Café Notes.mdz>) — Unicode file names
- [Library](Archives/Library.mdz) — 200 documents, for search and graph
- [Broken archive](Archives/Broken.mdz) and [missing entry point](Archives/Missing%20Entry.mdz) — error handling

## Into archives (links to documents inside an .mdz)
- Relative: [Setup guide](Projects/Alpha%20Handbook.mdz/guide/setup.md)
- With a heading: [Advanced › Tuning](Projects/Alpha%20Handbook.mdz/guide/advanced.md#Tuning)
- Wikilink with path: [[Projects/Alpha Handbook.mdz/reference/api.md]]
- Missing document inside an archive: [Nope](Projects/Alpha%20Handbook.mdz/guide/nope.md)

## Files
- ![[diagram.svg]] and ![[photo.png|120]]
- [[paper.pdf]] — a 2-page PDF; [[paper.pdf#page=2|page 2]]
- [[measurements.csv]], [[settings.json]], [[Map.canvas]]
""",
        "Test Plan.md": TEST_PLAN,
        "Paste Here.md": """# Paste Here

A plain note for testing **paste-to-convert**: paste or drop an image below.
With the plugin setting on "Ask each time", you should be asked whether to
convert this note to `.mdz`.

It embeds a vault image, so converting should copy it into the archive:

![[photo.png]]

Paste below this line:

""",
        "People/Ada Lovelace.md": """---
tags: [person]
born: 1815
---
# Ada Lovelace

Wrote the first published algorithm. Related: [[Grace Hopper]], [[Zettelkasten]].

The [Field Guide](../Archives/Field%20Guide.mdz) mentions her in its history section.
""",
        "People/Grace Hopper.md": """---
tags: [person]
born: 1906
---
# Grace Hopper

Popularised machine-independent languages. See also [[Ada Lovelace]].
""",
        "Concepts/Zettelkasten.md": """# Zettelkasten

Atomic notes, densely linked. #method

Links from inside archives reach this note by name: the Field Guide uses `[[Zettelkasten]]`.
See [[Linking]] for link styles.
""",
        "Concepts/Linking.md": """# Linking

## Heading links

Link to a heading with `[[Linking#Heading links]]`.

## Block references

The key idea is that links make notes discoverable. ^key-idea

## Into archives

From a note, link to a document inside an archive with an ordinary path:
`[Setup](../Projects/Alpha%20Handbook.mdz/guide/setup.md)` →
[Setup](../Projects/Alpha%20Handbook.mdz/guide/setup.md)
""",
        "Projects/Project Alpha.md": """---
tags: [project]
status: active
---
# Project Alpha

The handbook lives in [[Alpha Handbook.mdz]] (shortest-name wikilink to the archive).

- Start: [Handbook home](Alpha%20Handbook.mdz)
- [API reference](Alpha%20Handbook.mdz/reference/api.md)
- Owner: [[Ada Lovelace]]
- Field notes: [Field Guide › Birds](../Archives/Field%20Guide.mdz/birds.md)
""",
        "Daily/2026-10-10.md": """# 2026-10-10

- Reviewed [[Project Alpha]]
- Read [[paper.pdf#page=1]]
- Added photos to the [Field Guide](../Archives/Field%20Guide.mdz)
""",
        "Daily/2026-10-11.md": """# 2026-10-11

- Yesterday: [[2026-10-10]]
- Cooked from [Recipes](../Recipes.mdz) — the [pancakes](../Recipes.mdz/recipes/pancakes.md)
""",
    }


TEST_PLAN = """# Test Plan

Each item says where to look. Tick them off as you go. (Re-run
`python scripts/make-test-vault.py --force` in the plugin repo to reset the vault.)

## Opening and editing
- [ ] Open [Field Guide](Archives/Field%20Guide.mdz): Obsidian's own editor; images show in live preview and reading view.
- [ ] Toggle reading/editing (book icon) and source mode: stays in the MDZip view (never raw ZIP text).
- [ ] Edit, wait for autosave, close and reopen: the edit is saved; images still there.
- [ ] Open [Broken](Archives/Broken.mdz): error banner, nothing saved. Open [Missing Entry](Archives/Missing%20Entry.mdz): `entryPoint` error banner.
- [ ] Word count in the status bar matches the document, not the ZIP size.

## Projects and documents
- [ ] Open [[Projects/Alpha Handbook.mdz|Alpha Handbook]]: the header reads `Projects / Alpha Handbook / index`; two header icons (archive contents, links); no button bar in the note. *MDZip: Open document in archive* lists the documents.
- [ ] Follow links between its documents; back/forward works; Ctrl-click opens a new tab.
- [ ] Inside it, `[[setup]]` (a wikilink by name) opens `guide/setup.md`.
- [ ] Restart Obsidian: tabs reopen on the same document.
- [ ] *Archive contents* pane (folder-tree icon in the tab header, or *MDZip: Show archive contents*): the archive's tree in its own section below Files (both visible), entry point first with a house icon, current document highlighted, `manifest` dimmed. Clicking a document opens it; clicking `logo` or `manifest` shows a preview; right-click offers *Open in new tab*, *Copy path* and *Copy link for a note next to the archive*.
- [ ] In the *Archive contents* pane, **+** → *Add README.md* on the Field Guide: it's added, opens for editing, and the Field Guide still opens on `index.md`. **+** again shows *Open README.md*.
- [ ] Right-click a `.mdz` in Files: *Add README.md* / *Add AGENTS.md*. Right-click a note: *Convert to MDZip*.
- [ ] Two tabs on Alpha Handbook showing different documents (Ctrl-click a link): type in one, then switch documents in the other. Neither document takes the other's text.

## Links across the archive boundary
- [ ] From the Field Guide: `../../People/Ada Lovelace.md` opens the vault note. `![logo](../../Attachments/photo.png)` stays hidden by default, and shows after turning on Settings → MDZip → "Show vault images linked from archives" (spec Section 9.6).
- [ ] From the Field Guide: a link into `Projects/Alpha Handbook.mdz` opens that document.
- [ ] From [[Home]]: every link under "Into archives" opens the right document; the missing one shows a notice and creates no note.
- [ ] From [[Project Alpha]]: the shortest-name wikilink `[[Alpha Handbook.mdz]]` opens the archive.
- [ ] From inside an archive, a missing link (`../Missing.md`) shows a notice; no stray note appears.
- [ ] [Recipes](Recipes.mdz) opens on `recipes.md` (support files set aside); its `README.md` and `AGENTS.md` are listed (dimmed) in the *Archive contents* pane.
- [ ] [Café Notes](<Archives/Café Notes.mdz>): links to `résumé.md` and `笔记/索引.md` open.

## Images
- [ ] In an archive document, paste an image: saved inside the archive (`images/`), its own paragraph.
- [ ] Drag an image file onto an archive document: same.
- [ ] Settings → MDZip → *Images pasted into archives* → *Ask each time*, then paste: the Insert image dialog shows the image's size. Choose HTML, width 150, Center: it appears centered at 150 px, in live preview and reading view. *Wrap right* lets the text flow beside it. *Cancel* inserts nothing.
- [ ] In [[Paste Here]], paste an image: the convert dialog appears; *Convert* turns it into `Paste Here.mdz`, copies `photo.png` in, updates links.
- [ ] *Paste normally* saves to `Attachments/` as usual.

## Graph, search and links panel
- [ ] Graph view: archive documents appear as nodes; edges between notes and archive documents; no faded stand-ins for links that resolve.
- [ ] Local graph with an archive document open: centred on that document.
- [ ] *MDZip search* (ribbon): search `osprey` (Field Guide), `pancake` (Recipes), `lorem` (Library, many hits); results open at the line.
- [ ] Core search for `quantum entanglement` finds nothing (it's inside `paper.pdf`, which core search doesn't index).
- [ ] *Archive links* panel on an archive document: incoming, outgoing, not found. On [[Ada Lovelace]]: an explanation line, then "Linked from archives" lists the Field Guide. On [[Linking]] (no archive links): one "No links to or from archives" line.

## Safety
- [ ] Rename an archive in the file explorer: links to it from notes update (with "Automatically update internal links" on).
- [ ] Turn the plugin off with an archive open, then on again: the tab returns to the MDZip view, archive unchanged.
- [ ] Settings → MDZip → "Show vault images linked from archives" is off on a new install.
"""


def archives() -> dict:
    """name → .mdz bytes (or raw bytes for the broken ones)."""
    out = {}
    out["Archives/Field Guide.mdz"] = mdzip_core.create(
        {
            "index.md": """# Field Guide

A single-document archive with its own images, plus links that leave it.

![Field guide cover](images/cover.png)

## Contents
- [Birds](birds.md) — a second document in this archive
- [[Zettelkasten]] — a wikilink by name to a vault note

## History
[Ada Lovelace](../../People/Ada%20Lovelace.md) appears here as a link out of the archive
(the archive sits in `Archives/`, so the vault root is `../../`).

Image from the vault, outside this archive: ![photo](../../Attachments/photo.png)

Into another archive: [Alpha setup](../../Projects/Alpha%20Handbook.mdz/guide/setup.md)

Missing on purpose: [nothing here](../Missing.md)

<a href="../../Home.md">HTML link back to Home</a>
""",
            "birds.md": """# Birds

The osprey dives feet-first. ![Osprey](images/osprey.svg)

Back to the [field guide](index.md).
""",
            "images/cover.png": png(160, 90, DARK, LIGHT),
            "images/osprey.svg": svg("Osprey"),
            "AGENTS.md": "# AGENTS.md\n\nThis archive is an MDZip (`.mdz`) file. See https://github.com/mdzip-project/mdzip-spec\n",
        },
        title="Field Guide",
    )
    out["Projects/Alpha Handbook.mdz"] = mdzip_core.create(
        {
            "index.md": """# Alpha Handbook

Project-mode archive: several separate documents.

- [[setup]] (wikilink by name to `guide/setup.md`)
- [Advanced](guide/advanced.md) and its [tuning section](guide/advanced.md#Tuning)
- [API reference](reference/api.md)
- Back to the project note: [Project Alpha](../Project%20Alpha.md)
- Across to the [Field Guide](../../Archives/Field%20Guide.mdz)

![Logo](images/logo.png)
""",
            "guide/setup.md": "# Setup\n\nInstall, then read [Advanced](advanced.md). Up to the [handbook home](../index.md).\n\nOwner: [Ada](../../../People/Ada%20Lovelace.md)\n",
            "guide/advanced.md": "# Advanced\n\n## Tuning\n\nTune carefully. See the [API](../reference/api.md).\n\n## Pitfalls\n\nNone known.\n",
            "reference/api.md": "# API\n\n`alpha.run()` starts everything. Back to [setup](../guide/setup.md).\n",
            "images/logo.png": png(96, 96, BLUE, LIGHT),
        },
        title="Alpha Handbook",
        mode="project",
        entry_point="index.md",
    )
    # No manifest (a "zipped folder"). The only root-level Markdown besides recipes.md is the
    # support files README.md and AGENTS.md, so the entry point is recipes.md (spec 1.2.0 §5.5).
    buf = __import__("io").BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("recipes.md", "# Recipes\n\n- [Pancakes](recipes/pancakes.md)\n- Shopping list in [[measurements.csv]]\n")
        z.writestr("recipes/pancakes.md", "# Pancakes\n\nFlour, milk, eggs. One pancake per person, minimum.\n\nBack to [recipes](../recipes.md).\n")
        z.writestr("README.md", "# About This Package\n\nThis is an MDZip (`.mdz`) package. Primary content starts at `recipes.md`.\n")
        z.writestr("AGENTS.md", "# AGENTS.md\n\nAn MDZip archive; the entry point is `recipes.md` (support files are set aside).\n")
    out["Recipes.mdz"] = buf.getvalue()
    out["Archives/Café Notes.mdz"] = mdzip_core.create(
        {
            "index.md": "# Café Notes\n\n- [Résumé](r%C3%A9sum%C3%A9.md)\n- [笔记索引](%E7%AC%94%E8%AE%B0/%E7%B4%A2%E5%BC%95.md)\n- Angle brackets: [Résumé](<résumé.md>)\n",
            "résumé.md": "# Résumé\n\nAccented file name.\n",
            "笔记/索引.md": "# 索引\n\n中文文件名。返回 [首页](../index.md)。\n",
        },
        title="Café Notes",
        mode="project",
    )
    library = {"index.md": "# Library\n\n" + "\n".join(f"- [Topic {i:03d}](topics/topic-{i:03d}.md)" for i in range(1, 201)) + "\n"}
    for i in range(1, 201):
        prev_i, next_i = (i - 2) % 200 + 1, i % 200 + 1
        library[f"topics/topic-{i:03d}.md"] = (
            f"# Topic {i:03d}\n\nLorem ipsum dolor sit amet, topic {i} consectetur adipiscing elit.\n\n"
            f"Previous: [Topic {prev_i:03d}](topic-{prev_i:03d}.md) · Next: [Topic {next_i:03d}](topic-{next_i:03d}.md) · "
            f"[Library](../index.md)\n"
            + ("\nSee also [[Zettelkasten]].\n" if i % 25 == 0 else "")
        )
    out["Archives/Library.mdz"] = mdzip_core.create(library, title="Library", mode="project", entry_point="index.md")
    out["Archives/Broken.mdz"] = b"This is not a ZIP file; the plugin should show an error, not raw bytes.\n"
    buf = __import__("io").BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps({"spec": {"name": "mdzip-spec", "version": "1.2.0"}, "entryPoint": "start.md"}))
        z.writestr("README.md", "# Missing entry\n\nThe manifest points at `start.md`, which isn't here.\n")
    out["Archives/Missing Entry.mdz"] = buf.getvalue()
    return out


def other_files() -> dict:
    return {
        "Attachments/photo.png": png(200, 140, GREY, RED),
        "Attachments/diagram.svg": svg("Diagram"),
        "Attachments/paper.pdf": pdf(
            [
                ["MDZip test PDF - page 1", "", "This PDF exists to test links to PDFs.", "Search phrase: quantum entanglement."],
                ["Page 2", "", "Linked from notes as paper.pdf#page=2."],
            ]
        ),
        "Attachments/measurements.csv": "date,temperature,notes\n2026-10-10,18.5,clear\n2026-10-11,16.0,\"rain, wind\"\n",
        "Attachments/settings.json": json.dumps({"theme": "greyscale", "experimental": {"mdz": True}}, indent=2) + "\n",
        "Map.canvas": json.dumps(
            {
                "nodes": [
                    {"id": "home", "type": "file", "file": "Home.md", "x": 0, "y": 0, "width": 400, "height": 300},
                    {"id": "alpha", "type": "file", "file": "Projects/Project Alpha.md", "x": 480, "y": 0, "width": 400, "height": 300},
                    {"id": "guide", "type": "file", "file": "Archives/Field Guide.mdz", "x": 0, "y": 380, "width": 400, "height": 200},
                    {"id": "note", "type": "text", "text": "Canvas card linking [[Ada Lovelace]]", "x": 480, "y": 380, "width": 400, "height": 120},
                ],
                "edges": [{"id": "e1", "fromNode": "home", "toNode": "alpha"}, {"id": "e2", "fromNode": "home", "toNode": "guide"}],
            },
            indent=2,
        )
        + "\n",
    }


# ---- Obsidian setup -------------------------------------------------------


def write_obsidian_config(vault: Path) -> None:
    cfg = vault / ".obsidian"
    cfg.mkdir(exist_ok=True)
    defaults = {
        "app.json": {"attachmentFolderPath": "Attachments", "newLinkFormat": "shortest", "showUnsupportedFiles": True},
        "community-plugins.json": ["mdzip"],
        "core-plugins.json": ["file-explorer", "global-search", "switcher", "graph", "backlink", "outgoing-link", "page-preview", "word-count", "outline", "canvas", "daily-notes", "command-palette"],
    }
    for name, value in defaults.items():
        path = cfg / name
        if not path.exists():
            path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    plugins = cfg / "plugins"
    plugins.mkdir(exist_ok=True)
    link = plugins / "mdzip"
    if link.exists() or link.is_symlink():
        return
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(REPO)], check=True, capture_output=True)
    else:
        link.symlink_to(REPO, target_is_directory=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("target", nargs="?", default=str(WORKSPACE / "TestVault"))
    parser.add_argument("--force", action="store_true", help="rebuild an existing test vault (keeps .obsidian)")
    args = parser.parse_args()
    vault = Path(args.target).resolve()

    if vault.exists() and any(vault.iterdir()):
        if not (vault / MARKER).exists():
            sys.exit(f"{vault} exists and isn't a test vault made by this script; refusing to touch it.")
        if not args.force:
            sys.exit(f"{vault} already exists; use --force to rebuild it.")
        for child in vault.iterdir():
            if child.name == ".obsidian":
                continue
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()

    vault.mkdir(parents=True, exist_ok=True)
    files = {**notes(), **other_files(), **archives()}
    for rel, data in files.items():
        path = vault / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    (vault / MARKER).write_text("Made by mdzip-obsidian/scripts/make-test-vault.py. Safe to rebuild with --force.\n", encoding="utf-8")
    write_obsidian_config(vault)
    print(f"Test vault ready: {vault} ({len(files)} files). Open it in Obsidian with 'Open folder as vault'.")


if __name__ == "__main__":
    main()
