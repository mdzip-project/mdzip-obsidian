// README.md and AGENTS.md for archives (spec Sections 5.6 and 5.8), from the
// spec's sample templates (examples/templates/*.sample.md).

import { App, Notice, TFile } from 'obsidian';
import { MdzArchiveCore, MdzPackagerCore } from '@mdzip/core-js';
import { MdzView, VIEW_TYPE_MDZ, openArchive } from './mdz-view';

export type SupportFileKind = 'README' | 'AGENTS';

export const SUPPORT_FILE_PATHS: Record<SupportFileKind, string> = {
  README: 'README.md',
  AGENTS: 'AGENTS.md',
};

interface ArchiveInfo {
  title: string;
  entryPoint: string;
  mode: 'document' | 'project';
}

/** The text of a new support file, from the spec's templates. */
export function supportFileText(kind: SupportFileKind, info: ArchiveInfo): string {
  if (kind === 'README') {
    const start =
      info.mode === 'project'
        ? `- This package holds several separate documents. Start at \`${info.entryPoint}\`, which links to the others.`
        : `- Primary content starts at \`${info.entryPoint}\`.`;
    return `# About ${info.title}

This is an MDZip (\`.mdz\`) package: Markdown documents and their images in a single file.

${start}
- If your tool does not support \`.mdz\` directly, rename the file to \`.zip\` or unzip it, then open \`${info.entryPoint}\` in a Markdown viewer or editor (or a plain text editor).
- Format documentation: https://github.com/mdzip-project/mdzip-spec
`;
  }
  return `# AGENTS.md

This archive is an **MDZip (\`.mdz\`)** file: a ZIP container holding Markdown documents, their assets (images and other files), and usually a \`manifest.json\` describing them.

This file is guidance for AI agents and tools that open the archive without native \`.mdz\` support. It is advisory: when \`manifest.json\` is present, it is authoritative.

## Preferred access

Before reading or writing this archive, check whether archive-aware tooling is available, in this order:

1. An MDZip MCP server (look among your tools before assuming there isn't one).
2. An MDZip-compatible library.
3. An MDZip-compatible viewer or editor.
4. Manual ZIP inspection, as a last resort.

Archive-aware tooling can read entries and assets in memory, without extracting the archive, and can detect when a write would overwrite changes made elsewhere.

### Without MDZip tooling

- **Reading** with ordinary ZIP tools is fine. Prefer reading individual entries (for example \`manifest.json\` or one Markdown file) in memory over extracting the whole archive to disk.
- **Writing:** don't modify the archive with generic ZIP tools, scripts or manual byte edits. Ask the user how to proceed first; a generic write can't detect a conflicting edit made in another tool, and can break the archive's structure.

## Finding the entry point

This archive's entry point is \`${info.entryPoint}\`${info.mode === 'project' ? ' (it is a project: a collection of separate documents)' : ''}. In general:

1. If \`manifest.json\` has an \`entryPoint\`, use it. If that file isn't in the archive (paths are case-sensitive), tell the user instead of opening a different file.
2. Otherwise, use \`index.md\` at the archive root.
3. Otherwise, set aside these support files at the root: \`README\`, \`AGENTS\`, \`LICENSE\`, \`CHANGELOG\` and \`CONTRIBUTING\` (compared ignoring ASCII case, \`.md\` or \`.markdown\`). If exactly one root-level Markdown file remains, use it. If none remain and the archive has only one root-level Markdown file, use that.
4. Otherwise, don't guess; ask the user which document to open.

## Mode

Check \`mode\` in \`manifest.json\`:

- \`"document"\` (or no \`mode\`, or no manifest): the archive is one logical document. Other Markdown files are parts of it, such as chapters or appendices.
- \`"project"\`: the archive is a collection of separate documents. Keep them separate and preserve the links between them; don't merge them into one document unless asked.

## Assets and links

Markdown files reference images and other assets with relative paths. Resolve them from the location of the referencing file, and keep relative paths and links intact.

## Reference

- Specification: https://github.com/mdzip-project/mdzip-spec
- Website: https://mdzip.org
`;
}

/** The open tabs showing `file`. */
export function viewsOf(app: App, file: TFile): MdzView[] {
  return app.workspace
    .getLeavesOfType(VIEW_TYPE_MDZ)
    .map((leaf) => leaf.view)
    .filter((view): view is MdzView => view instanceof MdzView && view.file === file);
}

/** The open tab showing `file`, if any. */
export function viewOf(app: App, file: TFile): MdzView | null {
  return viewsOf(app, file)[0] ?? null;
}

/** The stored path of a root-level support file of this kind (any ASCII case), or null. */
function existingPath(archive: MdzArchiveCore, kind: SupportFileKind): string | null {
  const wanted = new RegExp(`^${kind}\\.(md|markdown)$`, 'i');
  const found = archive.listEntries().find((e) => !e.isDirectory && !e.path.includes('/') && wanted.test(e.path));
  return found?.path ?? null;
}

/**
 * Add a file at `path`, keeping the entry point where it is (spec Section
 * 14.1). An archive without a manifest gets one, so that the new file can't
 * make its entry point ambiguous (for example README.md + AGENTS.md alone, or
 * a second root-level document).
 */
export async function withEntry(bytes: ArrayBuffer, path: string, text: string): Promise<ArrayBuffer> {
  const opened = await openArchive(bytes);
  const manifest = await opened.archive.readManifest();
  const options = manifest
    ? undefined
    : { manifest: MdzPackagerCore.createManifest({ entryPoint: opened.entryPointPath, mode: opened.mode }) };
  const result = await MdzArchiveCore.updateFiles(new Uint8Array(bytes), [{ path, content: text }], [], options);
  const next = await result.blob.arrayBuffer();
  const reopened = await openArchive(next);
  if (reopened.entryPointPath !== opened.entryPointPath) {
    throw new Error(`adding ${path} would change the entry point; nothing was changed`);
  }
  return next;
}

/**
 * Change an archive through its open tab when there is one (so the change
 * can't race the tab's own saves), else directly in the vault. Other tabs on
 * the archive save first, so their edits are in the bytes being changed. When
 * the change moves entries, `moves` (old path → new, filled in by `change`)
 * lets every tab follow its document.
 */
export async function changeArchive(
  app: App,
  file: TFile,
  change: (bytes: ArrayBuffer) => Promise<ArrayBuffer>,
  moves?: ReadonlyMap<string, string>
): Promise<void> {
  const [view, ...others] = viewsOf(app, file);
  for (const other of others) {
    await other.save();
    if (moves) other.expectMoves(moves);
  }
  if (view) await view.modifyArchive(change, moves);
  else await app.vault.modifyBinary(file, await change(await app.vault.readBinary(file)));
}

/** Show a document of the archive, opening the archive in a tab first if it isn't open. */
export async function showInArchive(app: App, file: TFile, path: string): Promise<void> {
  let view = viewOf(app, file);
  if (!view) {
    await app.workspace.getLeaf(false).openFile(file);
    view = viewOf(app, file);
  }
  await view?.openDocument(path);
}

async function withSupportFile(bytes: ArrayBuffer, kind: SupportFileKind, fileName: string): Promise<ArrayBuffer> {
  const opened = await openArchive(bytes);
  const manifest = await opened.archive.readManifest();
  const title = manifest?.title || fileName.replace(/\.mdz$/i, '');
  const text = supportFileText(kind, { title, entryPoint: opened.entryPointPath, mode: opened.mode });
  return withEntry(bytes, SUPPORT_FILE_PATHS[kind], text);
}

/**
 * Add README.md or AGENTS.md to an archive, or open it if it's already there.
 * Goes through the archive's open tab when there is one, then shows the file
 * there so it can be edited.
 */
export async function addSupportFile(app: App, file: TFile, kind: SupportFileKind): Promise<void> {
  const name = SUPPORT_FILE_PATHS[kind];
  try {
    const existing = existingPath((await openArchive(await app.vault.readBinary(file))).archive, kind);
    if (!existing) {
      await changeArchive(app, file, (bytes) => withSupportFile(bytes, kind, file.name));
      new Notice(`Added ${name} to ${file.name}.`);
    }
    await showInArchive(app, file, existing ?? name);
  } catch (err) {
    new Notice(`Couldn't add ${name} to ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
