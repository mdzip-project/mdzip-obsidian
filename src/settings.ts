import { App, PluginSettingTab, Setting } from 'obsidian';
import type MdzPlugin from './main';
import type { MarkdownPasteBehavior } from './convert';

export interface MdzSettings {
  /** What happens when an image is pasted or dropped into a regular Markdown note. */
  markdownPaste: MarkdownPasteBehavior;
}

export const DEFAULT_SETTINGS: MdzSettings = {
  markdownPaste: 'ask',
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
  }
}
