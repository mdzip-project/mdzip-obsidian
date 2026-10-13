import { App, PluginSettingTab, Setting } from 'obsidian';
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Images pasted into Markdown notes')
      .setDesc(
        'Converting turns the note into an .mdz, so the note and its images stay together in one file. ' +
          'Saving to the vault uses Obsidian\'s usual attachment location.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('ask', 'Ask each time')
          .addOption('convert', 'Convert the note to .mdz')
          .addOption('vault', 'Save to the vault as usual')
          .setValue(this.plugin.settings.markdownPaste)
          .onChange(async (value) => {
            this.plugin.settings.markdownPaste = value as MarkdownPasteBehavior;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Images pasted into archives')
      .setDesc(
        'How a pasted or dropped image is written in a .mdz document. HTML lets you set its size and alignment ' +
          '(left, center, right, or text wrapping around it), the same way MDZip Studio and the VS Code extension do.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('markdown', 'Markdown image')
          .addOption('ask', 'Ask each time (size and alignment)')
          .addOption('html', 'HTML <img>')
          .setValue(this.plugin.settings.archiveImages)
          .onChange(async (value) => {
            this.plugin.settings.archiveImages = value as ImageInsertMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Show vault images linked from archives')
      .setDesc(
        'Lets a document inside an .mdz show images from your vault that it links to outside the archive, such as ' +
          '![](../photo.png). Off by default, because an archive from someone else could use it to display files ' +
          'from your vault. Links you click are unaffected.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.outsideImages).onChange(async (value) => {
          this.plugin.settings.outsideImages = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
