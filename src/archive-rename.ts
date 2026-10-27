// When a .mdz is renamed or moved, update links from notes into its
// documents (see note-links.ts). Obsidian updates links to the .mdz file
// itself; this covers the deeper links it can't see.

import { App, Modal, Notice, Plugin, Setting, TAbstractFile, TFile } from 'obsidian';
import { rewriteLinksIntoArchive, type ArchiveRename } from './note-links';

const isMdzPath = (path: string) => /\.mdz$/i.test(path);

export function watchArchiveRenames(plugin: Plugin): void {
  const { app } = plugin;
  plugin.registerEvent(
    app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
      if (!(file instanceof TFile) || !isMdzPath(oldPath) || !isMdzPath(file.path)) return;
      const rename: ArchiveRename = {
        from: oldPath,
        to: file.path,
        others: app.vault.getFiles().filter((f) => f !== file && isMdzPath(f.path)).map((f) => f.path),
      };
      afterObsidiansLinkUpdate(app, () => updateLinksInto(app, rename));
    })
  );
}

/**
 * Run `task` once Obsidian has finished updating links for the rename
 * (including waiting for its "Update links?" question), so the two never
 * edit the same note at once. Obsidian runs those updates through an
 * internal queue; without it, wait a moment and for the metadata cache.
 */
function afterObsidiansLinkUpdate(app: App, task: () => Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await task();
    } catch (err) {
      new Notice(`MDZip couldn't update links: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const queue = (app.fileManager as unknown as { updateQueue?: { queue?: (fn: () => Promise<void>) => unknown } }).updateQueue;
  if (typeof queue?.queue === 'function') {
    void queue.queue(run);
    return;
  }
  window.setTimeout(() => {
    const cache = app.metadataCache as unknown as { onCleanCache?: (cb: () => void) => void };
    if (cache.onCleanCache) cache.onCleanCache(() => void run());
    else void run();
  }, 500);
}

async function updateLinksInto(app: App, rename: ArchiveRename): Promise<void> {
  const oldName = rename.from.slice(rename.from.lastIndexOf('/') + 1).toLowerCase();
  // Obsidian lists links into archives as unresolved; read only the notes that have one naming the archive.
  const unresolved = app.metadataCache.unresolvedLinks;
  const notes = app.vault
    .getMarkdownFiles()
    .filter((f) => Object.keys(unresolved[f.path] ?? {}).some((l) => l.toLowerCase().includes(oldName)));

  const changes: { file: TFile; count: number }[] = [];
  for (const file of notes) {
    const { count } = rewriteLinksIntoArchive(await app.vault.cachedRead(file), file.path, rename);
    if (count) changes.push({ file, count });
  }
  if (!changes.length) return;

  const links = changes.reduce((n, c) => n + c.count, 0);
  const summary = `${links} link${links === 1 ? '' : 's'} in ${changes.length} note${changes.length === 1 ? '' : 's'}`;
  const config = app.vault as unknown as { getConfig(key: string): unknown };
  if (!config.getConfig('alwaysUpdateLinks')) {
    const newName = rename.to.slice(rename.to.lastIndexOf('/') + 1);
    if (!(await confirmUpdate(app, newName, summary))) return;
  }
  let updated = 0;
  for (const { file } of changes) {
    // Recomputed on the current text, in case the note changed meanwhile.
    await app.vault.process(file, (text) => {
      const result = rewriteLinksIntoArchive(text, file.path, rename);
      updated += result.count;
      return result.text;
    });
  }
  new Notice(`Updated ${updated} link${updated === 1 ? '' : 's'} into ${rename.to.slice(rename.to.lastIndexOf('/') + 1)}.`);
}

/** Asked when "Automatically update internal links" is off, like Obsidian's own question. */
function confirmUpdate(app: App, archiveName: string, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new (class extends Modal {
      private answered = false;
      onOpen(): void {
        this.setTitle('Update links into the archive?');
        this.contentEl.createEl('p', { text: `Notes link to documents inside ${archiveName}, which was renamed or moved.` });
        this.contentEl.createEl('p', { text: `This will affect ${summary}.` });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText('Do not update').onClick(() => this.answer(false)))
          .addButton((b) => b.setButtonText('Update').setCta().onClick(() => this.answer(true)));
      }
      onClose(): void {
        this.contentEl.empty();
        if (!this.answered) resolve(false);
      }
      answer(value: boolean): void {
        this.answered = true;
        this.close();
        resolve(value);
      }
    })(app);
    modal.open();
  });
}
