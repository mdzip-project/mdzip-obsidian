# In-app tests

These suites test the plugin inside a real Obsidian, so they reach the parts unit tests can't: opening archives in the editor, link clicks, the graph, the contents pane, drag-and-drop, dialogs, pasting images and renaming files. They cover the test vault's **Test Plan** note and more.

## Running

```bash
npm run build                      # the suites test main.js as built
npm run test:app                   # every suite
npm run test:app -- graph rename   # only suites whose file name contains a word
VERBOSE=1 npm run test:app         # show details for passing checks too
```

- **Obsidian closed (recommended):** the runner starts it on the test vault, with the DevTools port open and background throttling off.
- **Obsidian already open:** it must have been started with `--remote-debugging-port=9222`. Otherwise close it and let the runner start it. If its window is hidden behind others, Chromium slows its timers and the tests crawl; the runner tries to bring it to the front.
- The vault must be the generated test vault (`python scripts/make-test-vault.py`, default `../TestVault`). The runner refuses any vault without its `.mdzip-test-vault` marker, because the suites create and delete files.

Settings: `MDZIP_TEST_VAULT` (vault folder), `OBSIDIAN_EXE` (if Obsidian isn't found), `CDP_PORT` (default 9222).

## What they change

Everything a suite creates goes in an `_app-test` folder, which is deleted when the suite ends, even if it fails. Settings a suite changes (such as *Automatically update internal links*) are put back. The suites also turn the plugin off and on, and leave the graph's options as they were.

## Writing a suite

Each file in `suites/` runs inside Obsidian as the body of an async function, with `app` and the helpers from `lib.js` in scope (`check`, `openFile`, `state`, `copyArchive`, `fillPrompt`, `waitFor`, `setConfig`, ...). Add checks with:

```js
await check('What should happen', async () => {
  // ... do it ...
  return { ok: condition, detail: whatToShowIfItFails };
});
```

Every check has a 30-second limit and each suite a 5-minute one. A few things learned the hard way:

- Follow a link from an archive document with `leaf.openLinkText(link, '<archive>.mdz')`. The source is the archive's own path, not `Archive.mdz/doc.md`. Otherwise Obsidian treats the link as a new note and creates it.
- Close or answer every dialog a check opens. A dialog left open can block a later rename (Obsidian queues its link updates).
- Stopping the runner doesn't stop a script already running inside Obsidian. If a run is interrupted, reload Obsidian's window before running again.
