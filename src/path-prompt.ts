// A dialog asking for a path inside an archive, checked as it's typed.

import { App, ButtonComponent, Modal, Setting } from 'obsidian';

export interface PathPrompt {
  title: string;
  /** A paragraph above the field, if any. */
  description?: string;
  /** The starting value, and the part of it to select (default: all of it). */
  value: string;
  select?: [number, number];
  /** The final path, or why the value can't be used. */
  check: (value: string) => { path: string } | { error: string };
  /** Shown under the field while the value is valid, e.g. "Creates docs/setup.md". */
  describe: (path: string) => string;
  button: string;
  onSubmit: (path: string) => void;
}

export class PathPromptModal extends Modal {
  constructor(app: App, private prompt: PathPrompt) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, prompt } = this;
    this.setTitle(prompt.title);
    if (prompt.description) contentEl.createEl('p', { text: prompt.description });

    let value = prompt.value;
    let submitButton: ButtonComponent | undefined;
    const setting = new Setting(contentEl).setName('Path in the archive');
    const status = () => {
      const result = prompt.check(value);
      setting.setDesc('error' in result ? result.error : prompt.describe(result.path));
      setting.descEl.toggleClass('mdz-path-prompt-error', 'error' in result);
      submitButton?.setDisabled('error' in result);
      return result;
    };
    const submit = () => {
      const result = status();
      if ('error' in result) return;
      this.close();
      prompt.onSubmit(result.path);
    };

    setting.addText((text) => {
      text.setValue(value).onChange((next) => {
        value = next;
        status();
      });
      text.inputEl.addClass('mdz-path-prompt-input');
      text.inputEl.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' && !evt.isComposing) {
          evt.preventDefault();
          submit();
        }
      });
      const [start, end] = prompt.select ?? [0, value.length];
      window.setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.setSelectionRange(start, end);
      }, 0);
    });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((btn) => {
        submitButton = btn;
        btn.setButtonText(prompt.button).setCta().onClick(submit);
      });
    status();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
