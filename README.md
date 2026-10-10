# mdzip-obsidian

MDZip plugin for Obsidian. Read and write `.mdz` archives — single documents and multi-document projects — in Obsidian's own editor.

## Features

- **Open and edit `.mdz` files in Obsidian's own editor** — live preview, source mode, reading view, properties and hotkeys all work as they do for a normal note. Images stored inside the archive are displayed in every mode.
- **Saves back into the archive** — edits autosave (and Mod+S saves immediately) into the `.mdz`. Only the document being edited is rewritten; all other archive contents (other documents, assets, manifest, etc.) are preserved. Archives over 25 MB autosave after 30 seconds instead of 2, since each save rewrites the whole file.
- **Paste or drop images into the archive** — images pasted or dragged into a `.mdz` note are stored inside the archive under `images/` next to the document (not in the vault) and linked with standard Markdown image syntax.
- **Project-mode archives** — a project `.mdz` opens on its entry point. Links to other documents in the archive (Markdown links, wikilinks, and HTML `<a href>`) open them in the same tab, with back/forward history; Ctrl/⌘-click opens a new tab. A document bar shows where you are, and _Open document in archive_ lists every document. Tabs reopen on the document they were showing.
- **Turn a note into a `.mdz` when you paste an image** — pasting or dropping an image into a regular Markdown note asks whether to convert the note to `.mdz` so the image lives inside it. Converting renames `Note.md` to `Note.mdz` (links to it are updated) and copies the images the note already embeds into the archive; the vault copies are left in place. Choose _Ask each time_, _Convert the note to .mdz_ or _Save to the vault as usual_ under **Settings → MDZip**. The _Convert note to .mdz_ command does the same without an image.
- **Export note as `.mdz`** — command to package the currently active Markdown note into a new `.mdz` file placed alongside it in the vault.
- **Extract Markdown from `.mdz`** — command to pull the open document's Markdown out of a `.mdz` file and create a `.extracted.md` note in the vault.

> **Archive contents stay out of the vault.** Documents inside a `.mdz` don't appear in Obsidian's search, graph view or backlinks.

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
| Open another document (project archives) | Click a link to it, use **Documents…** in the document bar, or Command Palette → _MDZip: Open document in archive_ |
| Switch to reading view | Use the reading/editing toggle in the tab header, as for any note |
| Convert a note to `.mdz` | Paste or drop an image into it and choose **Convert**, or Command Palette → _MDZip: Convert note to .mdz_ |
| Export note as `.mdz` | Command Palette → _MDZip: Export note as .mdz_ |
| Extract Markdown | Command Palette → _MDZip: Extract Markdown from .mdz_ (with a `.mdz` file open) |

## Development

```bash
npm install        # install dependencies
npm run dev        # watch mode (rebuilds on change)
npm run build      # production build
```

Built on [`@mdzip/core-js`](https://github.com/mdzip-project/mdzip-core-js) and the [MDZip spec](https://github.com/mdzip-project/mdzip-spec).

