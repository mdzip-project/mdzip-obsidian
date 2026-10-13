# mdzip-obsidian

MDZip plugin for Obsidian. Read and write `.mdz` archives — single documents and multi-document projects — in Obsidian's own editor.

## Features

- **Open and edit `.mdz` files in Obsidian's own editor** — live preview, source mode, reading view, properties and hotkeys all work as they do for a normal note. Images stored inside the archive are displayed in every mode.
- **Saves back into the archive** — edits autosave (and Mod+S saves immediately) into the `.mdz`. Only the document being edited is rewritten; all other archive contents (other documents, assets, manifest, etc.) are preserved. Archives over 25 MB autosave after 30 seconds instead of 2, since each save rewrites the whole file.
- **Paste or drop images into the archive** — images pasted or dragged into a `.mdz` note are stored inside the archive under `images/` next to the document (not in the vault). **Settings → MDZip → Images pasted into archives** chooses how they're written: a Markdown image (the default), an HTML `<img>`, or _Ask each time_, which opens the same Insert image dialog as MDZip Studio and the VS Code extension — Markdown or HTML, alt text, size (width, height or a percentage of the image's real size) and position (left, center, right, or wrapped by text). Alignment is written as `<p align>` / `align` attributes, which every MDZip tool renders the same way.
- **Project-mode archives** — a project `.mdz` opens on its entry point. Links to other documents in the archive (Markdown links, wikilinks, and HTML `<a href>`) open them in the same tab, with back/forward history; Ctrl/⌘-click opens a new tab. The view header shows which document you're in (`Projects / Alpha Handbook / guide / setup`); the _Archive contents_ pane lists every document, and the _Open document in archive_ command picks one from the keyboard. Tabs reopen on the document they were showing.
- **Links across the archive boundary** (MDZip spec 1.2.0-draft, Sections 9.3–9.5) — from inside an archive, a relative link that climbs above its root reaches files next to the `.mdz` (`[Notes](../Notes.md)` from `index.md`), including images (`![logo](../logo.png)`) and other archives (`../Other.mdz/guide.md`). From a regular note, `[Design](Project.mdz/docs/design.md#overview)` opens a document inside an archive, and `[Project](Project.mdz)` opens its entry point; vault-absolute and shortest-name forms work too. Bare names (`[[Notes]]`) that aren't in the archive use Obsidian's usual vault-wide lookup — and so do single-name Markdown links like `[Notes](Notes.md)`, since Obsidian treats them the same way and doesn't tell the plugin which syntax was clicked. This is Obsidian-specific: under the MDZip spec, a Markdown link that doesn't resolve in the archive is unresolved (wikilinks are free to use name lookup, spec Section 9.7). A link that doesn't resolve shows a notice instead of creating a new note.
- **Archive documents in the graph** — Obsidian's graph and local graph show every document inside every `.mdz`: an archive's entry document is the archive's own node, other documents appear as `Project.mdz/docs/design.md`, and links between them, out of archives to notes and from notes into archives are drawn as edges. Clicking a node opens the document. A local graph follows the archive document you have open. Archive documents are hidden while a graph search filter is active.
- **Search inside `.mdz` files** — the _MDZip search_ view (ribbon icon, or Command Palette → _MDZip: Search inside .mdz files_) searches the text of every document in every archive as you type, smallest archives first, and opens a result at its line. Searches run on demand, with no stored index; a 150 MB archive takes a few seconds.
- **Archive contents pane** — the _Archive contents_ pane (the folder-tree icon in a `.mdz` tab's header, or Command Palette → _MDZip: Show archive contents_) shows the open archive's files as a tree in its own section of the left sidebar, below the file explorer (drag it elsewhere, such as the right sidebar, and it stays there), styled like the file explorer. The entry point is pinned first and marked, the current document is highlighted, support files (`README.md`, `AGENTS.md`, …) and `manifest.json` are dimmed, and images no document uses are shown in italics. Click a document to open it (Ctrl/⌘-click for a new tab); click an image or the manifest for a preview. Right-click to copy an entry's path, or a link that a note next to the archive can use to reach it.
- **Add `README.md` or `AGENTS.md` to an archive** — from the _Archive contents_ pane's **+** button, a `.mdz` file's right-click menu, or the _Add README.md / AGENTS.md to the archive_ commands. They're filled in from the MDZip spec's templates with the archive's title and entry point, and open for editing. `README.md` tells a person how to open the package without MDZip tools; `AGENTS.md` tells AI agents how to handle it safely (spec Sections 5.6 and 5.8). An archive with no manifest gets one at the same time, so its entry point can't change. If the file is already there, it just opens.
- **Links panel for archive documents** — the _Archive links_ panel (the icon in a `.mdz` tab's header, or Command Palette → _MDZip: Show links for the current document_) lists what links to the open archive document (other archive documents, and notes linking to it or to the `.mdz` itself), what it links to, and links that aren't found. On a regular note it lists only the archive documents that link to it and its links into archives — the part Obsidian's own backlinks and outgoing-links panes can't see — and says so; a note with no such links shows a single "No links to or from archives" line.
- **Convert to MDZip** — right-click a note in Files (or use the note's ⋮ menu) and choose _Convert to MDZip_; the _Convert note to .mdz_ command does the same.
- **Turn a note into a `.mdz` when you paste an image** — pasting or dropping an image into a regular Markdown note asks whether to convert the note to `.mdz` so the image lives inside it. Converting renames `Note.md` to `Note.mdz` (links to it are updated) and copies the images the note already embeds into the archive; the vault copies are left in place. Choose _Ask each time_, _Convert the note to .mdz_ or _Save to the vault as usual_ under **Settings → MDZip**. The _Convert note to .mdz_ command does the same without an image.
- **Export note as `.mdz`** — command to package the currently active Markdown note into a new `.mdz` file placed alongside it in the vault.
- **Extract Markdown from `.mdz`** — command to pull the open document's Markdown out of a `.mdz` file and create a `.extracted.md` note in the vault.

> **Obsidian's own index still covers only `.md` files.** Archive documents appear in the graph and in _MDZip search_, but not in Obsidian's core search, quick switcher or backlinks pane (use _MDZip search_ and the _Archive links_ panel), and links into an archive from regular notes still look unresolved (faded) in those notes, although clicking them works. The graph integration adds archive nodes to the graph view's data only; Obsidian's metadata cache, which other plugins read, is untouched.
>
> **Obsidian's link autocomplete doesn't know about archives.** Inside a `.mdz`, Obsidian treats the archive as a single file, so with the _Relative path to file_ link format it writes links to neighbouring vault files one `../` short. Shortest-path and wikilink formats are unaffected.

## Installation

### Manual (development)

```bash
cd path/to/your/vault/.obsidian/plugins/
git clone https://github.com/mdzip-project/mdzip-obsidian
cd mdzip-obsidian
npm install
npm run build
```

Then enable the plugin under **Settings → Community plugins**.

## Usage

| Action | How |
|--------|-----|
| Open a `.mdz` file | Click it in the file explorer — it opens in Obsidian's editor |
| Edit and save | Edit as you would any note; changes autosave into the archive (Mod+S saves immediately) |
| Add an image | Paste it, or drag an image file onto the note — it is stored inside the `.mdz` |
| Open another document (project archives) | Click a link to it, click it in the _Archive contents_ pane, or Command Palette → _MDZip: Open document in archive_ |
| Switch to reading view | Use the reading/editing toggle in the tab header, as for any note |
| Convert a note to `.mdz` | Paste or drop an image into it and choose **Convert**, or Command Palette → _MDZip: Convert note to .mdz_ |
| Export note as `.mdz` | Command Palette → _MDZip: Export note as .mdz_ |
| Extract Markdown | Command Palette → _MDZip: Extract Markdown from .mdz_ (with a `.mdz` file open) |

## Development

```bash
npm install        # install dependencies
npm run dev        # watch mode (rebuilds on change)
npm run build      # production build
npm test           # link resolution (the spec's link fixture), link extraction, graph and link-index tests
```

Built on [`@mdzip/core-js`](https://github.com/mdzip-project/mdzip-core-js) and the [MDZip spec](https://github.com/mdzip-project/mdzip-spec).

