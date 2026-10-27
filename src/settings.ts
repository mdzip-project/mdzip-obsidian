import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type MdzPlugin from './main';
import type { MarkdownPasteBehavior } from './convert';
import type { ImageInsertMode } from './image-format';

export interface MdzSettings {
  /** What happens when an image is pasted or dropped into a regular Markdown note. */
  markdownPaste: MarkdownPasteBehavior;
  /**
   * Show vault images that an archive document links to outside its archive
   * (`![](../photo.png)`). Off by default (spec Section 9.6): an archive from
   * someone else could otherwise display files from the vault.
   */
  outsideImages: boolean;
  /**
   * How images pasted or dropped into an archive document are written, as in
   * MDZip Studio and the VS Code extension: a Markdown image, an HTML <img>,
   * or a dialog with size and alignment each time.
   */
  archiveImages: ImageInsertMode;
}

export const DEFAULT_SETTINGS: MdzSettings = {
  markdownPaste: 'ask',
  outsideImages: false,
  archiveImages: 'markdown',
};

export class MdzSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MdzPlugin) {
    super(app, plugin);
  }

  /** Declarative settings, so they also show up in Obsidian's settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Images pasted into Markdown notes',
        desc:
          'Converting turns the note into an .mdz, so the note and its images stay together in one file. ' +
          "Saving to the vault uses Obsidian's usual attachment location.",
        control: {
          type: 'dropdown',
          key: 'markdownPaste',
          options: { ask: 'Ask each time', convert: 'Convert the note to .mdz', vault: 'Save to the vault as usual' },
        },
      },
      {
        name: 'Images pasted into archives',
        desc:
          'How a pasted or dropped image is written in a .mdz document. HTML lets you set its size and alignment ' +
          '(left, center, right, or text wrapping around it), the same way MDZip Studio and the VS Code extension do.',
        control: {
          type: 'dropdown',
          key: 'archiveImages',
          options: { markdown: 'Markdown image', ask: 'Ask each time (size and alignment)', html: 'HTML <img>' },
        },
      },
      {
        name: 'Show vault images linked from archives',
        desc:
          'Lets a document inside an .mdz show images from your vault that it links to outside the archive, such as ' +
          '![](../photo.png). Off by default, because an archive from someone else could use it to display files ' +
          'from your vault. Links you click are unaffected.',
        control: { type: 'toggle', key: 'outsideImages' },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof MdzSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    this.plugin.settings = { ...this.plugin.settings, [key]: value };
    await this.plugin.saveSettings();
  }
}
