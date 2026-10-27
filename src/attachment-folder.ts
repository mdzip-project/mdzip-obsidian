// Where Obsidian saves a pasted image for a note, from its "Default location
// for new attachments" setting (`attachmentFolderPath`). Kept free of Obsidian
// imports so it can be tested directly.

/**
 * The vault folder new attachments for a note in `noteFolder` go to (`''` is
 * the vault's top folder). The setting is `/` (top folder), `./` (the note's
 * folder), `./sub` (a subfolder of the note's folder) or a folder path.
 */
export function attachmentFolder(setting: string | undefined, noteFolder: string): string {
  const value = (setting ?? '/').trim();
  const note = noteFolder === '/' ? '' : noteFolder.replace(/\/+$/, '');
  if (value === '' || value === '/') return '';
  if (value === '.' || value === './') return note;
  if (value.startsWith('./')) {
    const sub = value.slice(2).replace(/^\/+|\/+$/g, '');
    return note ? `${note}/${sub}` : sub;
  }
  return value.replace(/^\/+|\/+$/g, '');
}

/** The folder as a person reads it: `Attachments/`, or "the vault's top folder". */
export function describeFolder(folder: string): string {
  return folder ? `${folder}/` : "the vault's top folder";
}
