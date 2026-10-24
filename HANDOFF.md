# Handoff: archive organization work (2026-10-19)

Work done in a Claude Code session that ran from the `statement-downloader` workspace. Everything below is **uncommitted**. Delete this file once it's been read.

## State

- **mdzip-obsidian**: builds cleanly (`npm run build`); `npm test` passes 110/110. Not yet tried in Obsidian.
- **mdzip-core-js**: one bug fix, with a test. All 84 tests pass (3 skipped). `dist/` is rebuilt, and the plugin picks it up through its `file:../mdzip-core-js` symlink.

## What was built (mdzip-obsidian)

1. **New document in an archive.** Available from the command palette, a `.mdz` file's right-click menu, the Archive contents pane's **+** button, and a folder's right-click menu. Paths are checked as you type: invalid paths, existing entries (ignoring case), and root-level support-file names are refused. The new document starts with a `# Name` heading. If the archive has no manifest, one is created so the entry point can't move.
2. **New folders.** Written as real directory entries (`folder/`), so empty folders show in the pane.
3. **Rename and move.** Available from the pane's right-click menus, a folder picker, drag-and-drop onto folders (or the empty space for the root), and palette commands for the current document.
   - Links inside the archive are rewritten: Markdown links and images, reference definitions, HTML `href`/`src`, and wikilinks and embeds. A moved document's own relative links are fixed too, including ones that reach outside the archive (`../x.md`).
   - A link is rewritten only if it would otherwise stop pointing at the same file, so bare wikilinks stay bare.
   - A Markdown or HTML link that resolved by its path must still resolve by path afterwards (spec §9.3), so it keeps working in other MDZip tools. Only wikilinks, and links that already depended on Obsidian's name lookup, may keep using it.
   - Moving the entry point or the cover image updates `manifest.json`. The manifest is edited as raw JSON, so unknown fields are kept.
4. **Delete.** Asks for confirmation, lists the documents that link to the target, and clears the cover if the cover image is deleted. The entry point and `manifest.json` can't be deleted.
5. **Make entry point.** Available from the document's right-click menu and as a command.
6. **Open tabs follow moves.** The tab doing the change follows its document (via `modifyArchive(change, moves)`). Other tabs on the same archive are told about the moves (`expectMoves`) and follow once the reloaded bytes actually show the move. Before any change, every tab on the archive saves (`changeArchive` in `support-files.ts`).

### Files

| File | Role |
|---|---|
| `src/link-rewrite.ts` | Pure. Finds link positions (skipping code), resolves links the way the view does (`strict` = path only), rewrites them. |
| `src/archive-edit.ts` | Pure, uses core-js. `planMove` / `planRemove` / `newFolderPath`, then `applyMoves` / `applyRemove` / `applyNewFolder` / `applyEntryPoint`, plus `linksInto`. |
| `src/document-path.ts` | Pure. Checks the path of a new document. |
| `src/archive-actions.ts` | Obsidian UI: the `ArchiveActions` object, folder picker, delete confirmation. |
| `src/path-prompt.ts` | Shared path dialog (new document, new folder, rename). |
| `src/support-files.ts` | Now also exports `withEntry`, `changeArchive`, `showInArchive`, `viewsOf`. |
| `src/mdz-view.ts` | `listArchiveEntries` includes directory entries; `modifyArchive(change, moves?)`; `expectMoves`; `showLoaded`. |
| `src/contents-view.ts` | Takes an `ArchiveActions` object; right-click menus; drag-and-drop. |
| `src/main.ts` | Creates the actions object; `registerArchiveCommands()`. |
| `test/link-rewrite.test.ts`, `test/archive-edit.test.ts`, `test/document-path.test.ts` | New tests. |

Tested modules import their siblings with an explicit `.ts` extension (`node --test` runs the TypeScript directly).

## mdzip-core-js fix (needs a release)

`updateFiles` couldn't remove directory entries: it threw `ERR_NOT_FOUND`, because removals were checked against file paths only. The fix is one line in `src/mdz-core.ts` (`listPaths({ includeDirectories: true })`), with a test in `tests/spec-conformance.test.mjs`. The CHANGELOG has an `[Unreleased]` entry, and STATUS is set to ready-to-commit.

**Release it as 2.0.2 before the plugin ships.** Deleting or moving folders depends on it.

## Not done / open questions

- **Not tried in Obsidian.** Drag-and-drop, moving the document open in the current tab, and two tabs open on one archive are the parts the tests can't reach.
- **Links from vault notes into an archive** (`Project.mdz/docs/x.md`) aren't updated when entries move. This is documented in the README as a limitation.
- **Before submitting to the community plugin list:**
  - `manifest.json` and `package.json` still say "single-document". Suggested description: *"Open and edit .mdz (MDZip) archives: Markdown documents and their images in one file, with folders, links and search."*
  - The current description contains the word "Obsidian", which submission checks have flagged before.
  - The plugin ID `mdzip-obsidian` contains "obsidian", which has also been flagged; `mdzip` is safer. It can't change after the first release. The user hasn't decided on either point yet.
- **Memory:** `reference_mdzip.md` in the statement-downloader project's Claude memory belongs with this project; copy it over.
- **Possible follow-up:** an option in the new-document dialog to add a link to the new document from the current one.

## Context: similar plugins

No other Obsidian plugin edits multiple documents and images inside one container in place.
- **TextBundle/TextPack** is the closest format, but it holds one document. Obsidian's official Importer only imports it, and Alchemist exports it.
- Canvas Bundle, Export Markdown ZIP and Share as ZIP only export.
- Image Baker and Export as Base64 MD embed images as base64 in the note.
- The Obsidian forum's "TextBundle support" thread is a possible place to promote MDZip.
