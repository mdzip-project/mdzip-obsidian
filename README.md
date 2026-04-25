# mdzip-obsidian

MDZip plugin for Obsidian. Provides the ability to read and write single document .mdz files.

## Features

- **Open `.mdz` files** directly in Obsidian — the entry-point Markdown is rendered using Obsidian's own preview renderer, with archive-local images resolved to inline data URIs.
- **Edit & save** — switch to _Edit_ mode to modify the Markdown source, then save it back into the `.mdz` archive (Mod+S or the toolbar Save button). Only the entry-point file is updated; all other archive contents (assets, manifest, etc.) are preserved.
- **Export note as `.mdz`** — command to package the currently active Markdown note into a new `.mdz` file placed alongside it in the vault.
- **Extract Markdown from `.mdz`** — command to pull the entry-point Markdown out of an open `.mdz` file and create a `.extracted.md` note in the vault.

> **Document mode only.** Project-mode `.mdz` archives (`"mode": "project"` in `manifest.json`) are not supported by this plugin.

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
| Open a `.mdz` file | Click it in the file explorer — it opens in the MDZip viewer automatically |
| Switch to edit mode | Click **Edit** in the toolbar |
| Save changes | Click **Save** or press Mod+S |
| Switch back to preview | Click **Preview** in the toolbar |
| Export note as `.mdz` | Command Palette → _MDZip: Export note as .mdz_ |
| Extract Markdown | Command Palette → _MDZip: Extract Markdown from .mdz_ (with a `.mdz` file open) |

## Development

```bash
npm install        # install dependencies
npm run dev        # watch mode (rebuilds on change)
npm run build      # production build
```

Built on [`mdzip-core-js`](https://github.com/mdzip-project/mdzip-core-js) and the [MDZip spec](https://github.com/mdzip-project/mdzip-spec).

