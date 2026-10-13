import { App, Editor, EditorPosition, MarkdownView, Modal, Notice, Setting, TFile } from 'obsidian';
import { MdzArchiveCore, MdzPackagerCore } from '@mdzip/core-js';
import { blockPadding, imageExtension, safeFileStem } from './images';
import { VIEW_TYPE_MDZ } from './mdz-view';

/** What to do with images pasted or dropped into a regular Markdown note. */
export type MarkdownPasteBehavior = 'ask' | 'convert' | 'vault';

/** Where incoming images go in the editor. */
export interface InsertTarget {
  from: EditorPosition;
  to: EditorPosition;
}

/** An image to add to an archive, at an archive path. */
interface ArchiveImage {
  path: string;
  data: Uint8Array;
}

/**
 * Convert a Markdown note into a document-mode .mdz in place: `Note.md`
 * becomes `Note.mdz` (renamed through the file manager, so links to it are
 * updated), with the note's text as the entry point.
 *
 * Images the note already embeds from the vault are copied into the
 * archive under `images/` and their links rewritten to point there; the vault
 * copies are left alone, since other notes may use them. `newImages`
 * (pasted or dropped) are added the same way and linked at `target`.
 */
export async function convertNoteToMdz(
  app: App,
  view: MarkdownView,
  newImages: File[] = [],
  source: 'paste' | 'drop' = 'paste',
  target?: InsertTarget,
  /** Markup for each new image (the "Images pasted into archives" setting); null leaves it out. */
  markup: (path: string, image: File, alt: string) => Promise<string | null> = async (path, _image, alt) =>
    `![${alt}](${path})`
): Promise<void> {
  const file = view.file;
  if (!file || file.extension !== 'md') return;
  const editor = view.editor;

  try {
    const images: ArchiveImage[] = [];
    const taken = new Set<string>();
    const claim = (stem: string, ext: string) => {
      let path = `images/${stem}.${ext}`;
      for (let n = 1; taken.has(path.toLowerCase()); n++) path = `images/${stem}-${n}.${ext}`;
      taken.add(path.toLowerCase());
      return path;
    };

    // New images go in first, at the cursor (or drop point), as their own paragraph.
    let text = editor.getValue();
    let cursorOffset: number | null = null;
    if (newImages.length && target) {
      const links: string[] = [];
      for (const image of newImages) {
        const stem =
          source === 'paste' ? `pasted-${Date.now()}` : safeFileStem(image.name) || `dropped-${Date.now()}`;
        const path = claim(stem, imageExtension(image));
        const link = await markup(path, image, source === 'paste' ? 'Pasted image' : stem);
        if (link === null) continue;
        images.push({ path, data: new Uint8Array(await image.arrayBuffer()) });
        links.push(link);
      }
      const { before, after } = blockPadding(editor, target.from, target.to);
      const inserted = before + links.join(before || after ? '\n\n' : '\n') + after;
      const from = editor.posToOffset(target.from);
      text = text.slice(0, from) + inserted + text.slice(editor.posToOffset(target.to));
      cursorOffset = from + inserted.length;
    }

    // Then pull the note's existing vault images into the archive.
    const newPaths = new Set(images.map((img) => img.path));
    const packed = await packEmbeddedImages(app, file, text, claim, newPaths);
    text = packed.text;
    images.push(...packed.images);
    if (cursorOffset !== null) cursorOffset += packed.shiftBefore(cursorOffset);

    const result = await MdzPackagerCore.buildArchive(
      [{ path: 'index.md', text }, ...images.map((img) => ({ path: img.path, data: img.data }))],
      file.basename,
      {
        createIndex: false,
        mapFiles: false,
        filters: ['**/*'],
        mode: 'document',
        entryPoint: 'index.md',
        title: file.basename,
      }
    );
    const bytes = await result.blob.arrayBuffer();

    // Flush the note, then turn it into the archive. The rename keeps the
    // same TFile and updates links; the text view still holding it can't
    // write to a .mdz (see guardMdzTextAccess).
    await view.save();
    const oldName = file.name;
    const mdzPath = availablePath(app, file.parent?.path ?? '', file.basename, 'mdz');
    await app.fileManager.renameFile(file, mdzPath);
    await app.vault.modifyBinary(file, bytes);

    const leaf = view.leaf;
    await leaf.setViewState({
      type: VIEW_TYPE_MDZ,
      state: { file: file.path, mode: 'source', source: false },
      active: true,
    });
    if (cursorOffset !== null && leaf.view instanceof MarkdownView) {
      const mdzEditor = leaf.view.editor;
      mdzEditor.setCursor(mdzEditor.offsetToPos(cursorOffset));
      mdzEditor.scrollIntoView({ from: mdzEditor.getCursor(), to: mdzEditor.getCursor() }, true);
    }
    const copied = packed.images.length;
    new Notice(
      `Converted ${oldName} to ${file.name}.` +
        (copied ? ` Copied ${copied} image${copied === 1 ? '' : 's'} into the archive.` : '')
    );
  } catch (err) {
    new Notice(`Converting ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Copy vault images embedded in `text` into the archive and rewrite their
 * links to the archive paths. Handles `![[image.png]]` (with `|alt` or
 * `|width` / `|widthxheight`) and `![alt](path/to/image.png)`; links to
 * anything that isn't a vault image (notes, URLs) are left as-is.
 */
async function packEmbeddedImages(
  app: App,
  file: TFile,
  text: string,
  claim: (stem: string, ext: string) => string,
  skip: Set<string>
): Promise<{ text: string; images: ArchiveImage[]; shiftBefore: (offset: number) => number }> {
  const embed = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g;
  const images: ArchiveImage[] = [];
  const byVaultPath = new Map<string, string>();
  const edits: { start: number; end: number; replacement: string }[] = [];

  for (const m of text.matchAll(embed)) {
    const isWiki = m[1] !== undefined;
    let linkpath = (isWiki ? m[1] : m[4]).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(linkpath) || skip.has(linkpath)) continue;
    try {
      linkpath = decodeURIComponent(linkpath);
    } catch {
      // Not URI-encoded; use as-is.
    }
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
    if (!dest || !MdzArchiveCore.IMAGE_MIME_TYPES[dest.extension.toLowerCase()]) continue;

    let archivePath = byVaultPath.get(dest.path);
    if (!archivePath) {
      archivePath = claim(safeFileStem(dest.name) || 'image', dest.extension.toLowerCase());
      byVaultPath.set(dest.path, archivePath);
      images.push({ path: archivePath, data: new Uint8Array(await app.vault.readBinary(dest)) });
    }

    let replacement: string;
    const size = isWiki ? /^(\d+)(?:x(\d+))?$/.exec((m[2] ?? '').trim()) : null;
    if (size) {
      // Obsidian's |width syntax has no CommonMark equivalent; keep the size with HTML.
      const height = size[2] ? ` height="${size[2]}"` : '';
      replacement = `<img src="${archivePath}" alt="${escapeAttr(dest.basename)}" width="${size[1]}"${height}>`;
    } else {
      const alt = isWiki ? (m[2]?.trim() || dest.basename) : m[3];
      replacement = `![${alt}](${archivePath})`;
    }
    edits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, replacement });
  }

  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.start) + e.replacement;
    last = e.end;
  }
  out += text.slice(last);
  const shiftBefore = (offset: number) =>
    edits.filter((e) => e.end <= offset).reduce((sum, e) => sum + e.replacement.length - (e.end - e.start), 0);
  return { text: out, images, shiftBefore };
}

/**
 * Save images into the vault the way Obsidian does by default (its
 * attachment-folder setting, `Pasted image <timestamp>` names, and its link
 * format) and link them at `target`.
 */
export async function pasteIntoVault(
  app: App,
  file: TFile,
  editor: Editor,
  images: File[],
  source: 'paste' | 'drop',
  target: InsertTarget
): Promise<void> {
  const links: string[] = [];
  for (const image of images) {
    const name =
      source === 'paste'
        ? `Pasted image ${timestamp()}.${imageExtension(image)}`
        : image.name || `Dropped image ${timestamp()}.${imageExtension(image)}`;
    const path = await app.fileManager.getAvailablePathForAttachment(name, file.path);
    const saved = await app.vault.createBinary(path, await image.arrayBuffer());
    links.push('!' + app.fileManager.generateMarkdownLink(saved, file.path));
  }
  editor.replaceRange(links.join('\n'), target.from, target.to);
}

/**
 * "Convert this note to .mdz?" — asked when an image is pasted or dropped
 * into a Markdown note and the setting is "Ask each time".
 */
export class ConvertNoteModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private noteName: string,
    private onDecide: (convert: boolean, remember: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle('Convert this note to .mdz?');
    contentEl.createEl('p', {
      text:
        'Markdown notes store pasted images as separate files in the vault. ' +
        'An .mdz keeps the note and its images together in one file.',
    });
    const mdzName = this.noteName.replace(/\.md$/i, '.mdz');
    contentEl.createEl('p', {
      text:
        `Converting renames ${this.noteName} to ${mdzName} and updates links to it. ` +
        'Images the note already uses are copied into the archive; the originals stay in the vault.',
    });

    let remember = false;
    new Setting(contentEl)
      .setName('Remember my choice')
      .setDesc('Change it later in the MDZip plugin settings.')
      .addToggle((toggle) => toggle.onChange((value) => (remember = value)));

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('Paste normally').onClick(() => this.decide(false, remember)))
      .addButton((btn) =>
        btn
          .setButtonText('Convert')
          .setCta()
          .onClick(() => this.decide(true, remember))
      );
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissed without choosing: paste the usual way rather than dropping the image.
    if (!this.decided) this.onDecide(false, false);
  }

  private decide(convert: boolean, remember: boolean): void {
    this.decided = true;
    this.close();
    this.onDecide(convert, remember);
  }
}

/** `folder/name.ext`, or `folder/name 1.ext`, `name 2.ext`, … if that's taken. */
function availablePath(app: App, folder: string, name: string, ext: string): string {
  const prefix = folder && folder !== '/' ? `${folder}/` : '';
  let path = `${prefix}${name}.${ext}`;
  for (let n = 1; app.vault.getAbstractFileByPath(path); n++) path = `${prefix}${name} ${n}.${ext}`;
  return path;
}

/** Local time as YYYYMMDDHHmmss, the stamp Obsidian puts in pasted image names. */
function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
