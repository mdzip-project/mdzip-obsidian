# MDZip for Obsidian

Keep a note and its pictures in one file. MDZip (`.mdz`) packs Markdown documents, their images and folders into a single file. This plugin opens and edits them right in Obsidian, in the same editor you use for every other note.

![An .mdz open in Obsidian, with its documents and images listed in the Archive contents pane](https://raw.githubusercontent.com/mdzip-project/mdzip-obsidian/main/docs/images/welcome.webp)

## Why use it

- **One file to share.** Send a guide, a report or a whole project as one `.mdz`, images included. No attachments folder to forget.
- **Opens anywhere.** An `.mdz` is a ZIP of plain Markdown files. MDZip Studio, VS Code and [MDZip.org](https://mdzip.org) open it too, and any unzip tool gets the files back out.
- **Nothing new to learn.** Live preview, source mode, reading view, properties and hotkeys work as they do for any note.

## Edit it like a normal note

Click an `.mdz` in the file explorer and it opens in Obsidian's editor. Edits save back into the file automatically. Paste or drop an image and it's stored inside the `.mdz`, not in your vault.

![A trail guide with a header picture and a table of trails, all stored in one .mdz](https://raw.githubusercontent.com/mdzip-project/mdzip-obsidian/main/docs/images/trail-guide.webp)

## Whole projects in one file

An `.mdz` can hold a folder of documents. The **Archive contents** pane shows them as a tree: add, rename, move and delete files there, and links between documents follow when you move them. The search box in the pane finds text in that archive.

![The Archive contents pane searching one archive for "water", with matching lines grouped by document](https://raw.githubusercontent.com/mdzip-project/mdzip-obsidian/main/docs/images/archive-contents.webp)

## Search every archive

**MDZip search** looks inside every `.mdz` in your vault as you type, and opens a result at the matching line.

![MDZip search listing 11 matches across 6 documents in two archives](https://raw.githubusercontent.com/mdzip-project/mdzip-obsidian/main/docs/images/search.webp)

## In the graph, linked to your notes

Every document inside every archive shows up in Obsidian's graph. Link from a note to `Project.mdz/docs/design.md`, or from inside an archive out to the notes next to it.

![Obsidian's graph showing regular notes and the documents inside two archives, linked together](https://raw.githubusercontent.com/mdzip-project/mdzip-obsidian/main/docs/images/graph.webp)

## On your phone too

It works in Obsidian's mobile app as well as on desktop.

![The trail guide and its Archive contents pane on a phone](https://raw.githubusercontent.com/mdzip-project/mdzip-obsidian/main/docs/images/phone.webp)

## Get started

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **MDZip**, then install and enable it.
2. Right-click a note and choose **Convert to MDZip**, or paste an image into a note and choose **Convert** when asked.
3. Or drop an `.mdz` you already have into your vault and click it.

## Good to know

- Obsidian's own search, quick switcher and backlinks don't look inside archives. Use **MDZip search** and the **Archive links** panel instead.
- Links from regular notes into an archive aren't updated when you move a file inside that archive.
- Deleting a file inside an archive can't be undone: Obsidian's trash doesn't see it.

## Privacy

MDZip works only on your vault, on your device. It makes no network requests and collects nothing. [Details](https://github.com/mdzip-project/mdzip-obsidian/blob/main/docs/guide.md#privacy).

## Learn more

- [Full guide](https://github.com/mdzip-project/mdzip-obsidian/blob/main/docs/guide.md): every feature, command and setting
- [MDZip.org](https://mdzip.org): what MDZip is and the other tools that open `.mdz` files
- [Report a bug or ask for a feature](https://github.com/mdzip-project/mdzip-obsidian/issues)

## Install from a release

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mdzip-project/mdzip-obsidian/releases/latest) into your vault's `.obsidian/plugins/mdzip/` folder, reload Obsidian and turn on MDZip under **Settings → Community plugins**. The release files are built on GitHub from this repository and carry an [artifact attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds); `gh attestation verify main.js --repo mdzip-project/mdzip-obsidian` checks one.

## Development

```bash
npm install        # install dependencies
npm run dev        # watch mode (rebuilds on change)
npm run build      # production build
npm test           # link resolution (the spec's link fixture), link extraction, graph and link-index tests
npm run test:app   # the plugin inside a real Obsidian, on the test vault (see scripts/app-tests/README.md)
```

To work on it inside a vault, clone this repository into `.obsidian/plugins/mdzip`, run `npm install` and `npm run build`, and enable it under **Settings → Community plugins**.

Built on [`@mdzip/core-js`](https://github.com/mdzip-project/mdzip-core-js) and the [MDZip spec](https://github.com/mdzip-project/mdzip-spec).
