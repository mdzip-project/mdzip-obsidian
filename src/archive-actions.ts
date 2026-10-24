// Changing what's in an archive: new documents and folders, renaming,
// moving, deleting, and choosing the entry point. Used by the Archive
// contents pane, the file menu and commands.

import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from 'obsidian';
import { MdzArchiveCore } from '@mdzip/core-js';
import { openArchive } from './mdz-view';
import { newDocumentPath, newDocumentText } from './document-path';
import { changeArchive, showInArchive, viewOf, viewsOf, withEntry, type SupportFileKind } from './support-files';
import { PathPromptModal } from './path-prompt';
import {
  applyEntryPoint,
  applyMoves,
  applyNewFolder,
  applyRemove,
  foldersOf,
  linksInto,
  listingOf,
  newFolderPath,
  planMove,
  planRemove,
  removeProblem,
  type Listing,
} from './archive-edit';

export interface ArchiveActions {
  addSupportFile(file: TFile, kind: SupportFileKind): Promise<void>;
  /** Ask for a name and add a document; `folder` is where the name starts out. */
  newDocument(file: TFile, folder?: string): Promise<void>;
  newFolder(file: TFile, parent?: string): Promise<void>;
  /** Ask for a new path (name, or folder too) for a file or folder. */
  rename(file: TFile, path: string, isFolder: boolean): Promise<void>;
  /** Pick a folder to move a file or folder to. */
  moveTo(file: TFile, path: string, isFolder: boolean): Promise<void>;
  /** Move a file or folder into `folder` (`''` is the root), as when dropped there. */
  moveInto(file: TFile, path: string, isFolder: boolean, folder: string): Promise<void>;
  /** Confirm, then delete a file or folder. */
  remove(file: TFile, path: string, isFolder: boolean): Promise<void>;
  setEntryPoint(file: TFile, path: string): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** The archive as it is now, with every tab's edits saved into it. */
async function current(app: App, file: TFile) {
  for (const view of viewsOf(app, file)) await view.save();
  const opened = await openArchive(await app.vault.readBinary(file));
  return { ...opened, listing: listingOf(opened.archive) };
}

function facts(opened: { entryPointPath: string; mode: 'document' | 'project' }) {
  return { entryPoint: opened.entryPointPath, mode: opened.mode };
}

/** Run an action, showing a notice if it fails. */
async function attempt(what: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    new Notice(`Couldn't ${what}: ${message(err)}`);
  }
}

export function archiveActions(app: App, addSupportFile: ArchiveActions['addSupportFile']): ArchiveActions {
  const move = (file: TFile, source: string, target: string, isFolder: boolean) =>
    attempt(`move ${source}`, async () => {
      const moves = new Map<string, string>();
      let moved = target;
      let rewritten: string[] = [];
      await changeArchive(
        app,
        file,
        async (bytes) => {
          // Planned again against the bytes being changed, in case the archive changed meanwhile.
          const opened = await openArchive(bytes);
          const plan = planMove(listingOf(opened.archive), source, target, isFolder);
          if ('error' in plan) throw new Error(plan.error);
          plan.moves.forEach((to, from) => moves.set(from, to));
          moved = plan.target;
          const result = await applyMoves(bytes, plan.moves, facts(opened));
          rewritten = result.rewritten;
          return result.bytes;
        },
        moves
      );
      const links = rewritten.length ? ` Updated links in ${plural(rewritten.length, 'document')}.` : '';
      new Notice(`Moved ${source} to ${moved}.${links}`);
    });

  return {
    addSupportFile,

    newDocument: (file, folder) =>
      attempt(`add a document to ${file.name}`, async () => {
        const view = viewOf(app, file);
        const { mode, listing } = await current(app, file);
        const start = folder ?? (view ? MdzArchiveCore.dirname(view.getCurrentDocument()) : '');
        const prefix = start ? `${start}/` : '';
        const entries = [...listing.files, ...listing.dirs];
        new PathPromptModal(app, {
          title: `New document in ${file.name}`,
          description:
            mode === 'project'
              ? 'Link to it from another document in the archive so readers can find it.'
              : 'This archive is a single document, so the new file becomes a part of it, such as a chapter. ' +
                'Link to it from another document so readers can find it.',
          value: `${prefix}Untitled.md`,
          // Select "Untitled", so typing replaces it and keeps the folder and extension.
          select: [prefix.length, prefix.length + 'Untitled'.length],
          check: (value) => newDocumentPath(value, entries),
          describe: (path) => `Creates ${path}`,
          button: 'Create',
          onSubmit: (path) =>
            void attempt(`add ${path} to ${file.name}`, async () => {
              await changeArchive(app, file, async (bytes) => {
                const checked = newDocumentPath(path, entryPaths(listingOf((await openArchive(bytes)).archive)));
                if ('error' in checked) throw new Error(checked.error);
                return withEntry(bytes, checked.path, newDocumentText(checked.path));
              });
              new Notice(`Added ${path} to ${file.name}.`);
              await showInArchive(app, file, path);
            }),
        }).open();
      }),

    newFolder: (file, parent = '') =>
      attempt(`add a folder to ${file.name}`, async () => {
        const { listing } = await current(app, file);
        const prefix = parent ? `${parent}/` : '';
        new PathPromptModal(app, {
          title: `New folder in ${file.name}`,
          value: `${prefix}Untitled`,
          select: [prefix.length, prefix.length + 'Untitled'.length],
          check: (value) => newFolderPath(value, listing),
          describe: (path) => `Creates the folder ${path}`,
          button: 'Create',
          onSubmit: (path) =>
            void attempt(`add the folder ${path}`, async () => {
              await changeArchive(app, file, async (bytes) => {
                const checked = newFolderPath(path, listingOf((await openArchive(bytes)).archive));
                if ('error' in checked) throw new Error(checked.error);
                return applyNewFolder(bytes, checked.path);
              });
              new Notice(`Added the folder ${path} to ${file.name}.`);
            }),
        }).open();
      }),

    rename: (file, path, isFolder) =>
      attempt(`rename ${path}`, async () => {
        const { listing } = await current(app, file);
        const start = path.lastIndexOf('/') + 1;
        const dot = path.lastIndexOf('.');
        const end = isFolder || dot <= start ? path.length : dot;
        new PathPromptModal(app, {
          title: `Rename ${nameOf(path)}`,
          description: 'Change the name, or the folders too to move it. Links to it in the archive are updated.',
          value: path,
          select: [start, end],
          check: (value) => {
            const plan = planMove(listing, path, value, isFolder);
            return 'error' in plan ? plan : { path: plan.target };
          },
          describe: (target) =>
            MdzArchiveCore.dirname(target) === MdzArchiveCore.dirname(path)
              ? `Renames it to ${nameOf(target)}`
              : `Moves it to ${target}`,
          button: 'Rename',
          onSubmit: (target) => void move(file, path, target, isFolder),
        }).open();
      }),

    moveTo: (file, path, isFolder) =>
      attempt(`move ${path}`, async () => {
        const { listing } = await current(app, file);
        const folders = destinations(listing, path, isFolder);
        if (!folders.length) {
          new Notice('There is no other folder to move it to. To move it to a new folder, use Rename.');
          return;
        }
        new FolderPicker(app, folders, (folder) => void move(file, path, join(folder, nameOf(path)), isFolder)).open();
      }),

    moveInto: async (file, path, isFolder, folder) => {
      if (MdzArchiveCore.dirname(path) === folder) return;
      if (isFolder && (folder === path || folder.startsWith(`${path}/`))) return;
      await move(file, path, join(folder, nameOf(path)), isFolder);
    },

    remove: (file, path, isFolder) =>
      attempt(`delete ${path}`, async () => {
        const opened = await current(app, file);
        const removed = planRemove(opened.listing, path, isFolder);
        const problem = removeProblem(removed, facts(opened));
        if (problem) {
          new Notice(problem);
          return;
        }
        const linkedFrom = await linksInto(opened.archive, removed);
        const cover = (await opened.archive.readManifest())?.cover;
        const files = removed.filter((p) => !p.endsWith('/'));

        const lines: string[] = [];
        lines.push(
          isFolder
            ? `This deletes the folder ${path} and ${files.length ? `the ${plural(files.length, 'file')} in it` : 'nothing else (it is empty)'} from ${file.name}.`
            : `This deletes ${path} from ${file.name}.`
        );
        if (linkedFrom.length) {
          lines.push(`Linked from ${linkedFrom.join(', ')}. Those links will stop working.`);
        }
        if (cover && removed.includes(cover)) lines.push(`${cover} is the archive's cover image; the cover will be cleared.`);
        lines.push("It can't be restored from Obsidian's trash.");

        new ConfirmModal(app, isFolder ? `Delete the folder ${nameOf(path)}?` : `Delete ${nameOf(path)}?`, lines, () =>
          void attempt(`delete ${path}`, async () => {
            await changeArchive(app, file, async (bytes) => {
              const now = await openArchive(bytes);
              return applyRemove(bytes, planRemove(listingOf(now.archive), path, isFolder), facts(now));
            });
            new Notice(`Deleted ${path} from ${file.name}.`);
          })
        ).open();
      }),

    setEntryPoint: (file, path) =>
      attempt(`make ${path} the entry point`, async () => {
        await changeArchive(app, file, async (bytes) => applyEntryPoint(bytes, path, facts(await openArchive(bytes))));
        new Notice(`${path} is now the entry point of ${file.name}.`);
      }),
  };
}

function entryPaths(listing: Listing): string[] {
  return [...listing.files, ...listing.dirs];
}

/** Folders a file or folder can move to: not where it is, and for a folder, not itself or inside itself. */
function destinations(listing: Listing, path: string, isFolder: boolean): string[] {
  const parent = MdzArchiveCore.dirname(path);
  return ['', ...foldersOf(listing)].filter(
    (f) => f !== parent && !(isFolder && (f === path || f.startsWith(`${path}/`)))
  );
}

/** Pick a folder of the archive (`''` is the root, shown as `/`). */
class FolderPicker extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private folders: string[],
    private onPick: (folder: string) => void
  ) {
    super(app);
    this.setPlaceholder('Move to a folder in the archive…');
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(folder: string): string {
    return folder || '/';
  }

  onChooseItem(folder: string): void {
    this.onPick(folder);
  }
}

/** Are you sure? With a warning button. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private heading: string,
    private lines: string[],
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.heading);
    for (const line of this.lines) this.contentEl.createEl('p', { text: line });
    new Setting(this.contentEl)
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText('Delete')
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
