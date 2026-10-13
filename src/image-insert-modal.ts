import { App, Modal, Setting } from 'obsidian';
import {
  formatImage,
  imageSize,
  type ImageInsertDecision,
  type ImageInsertMode,
  type ImagePosition,
  type ImageSizeMode,
} from './image-format';

/** The real size of an image file, or undefined if the browser can't decode it. */
async function intrinsicSize(image: Blob): Promise<{ width: number; height: number } | undefined> {
  const url = URL.createObjectURL(image);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : undefined;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The same choices as MDZip Studio's and the VS Code extension's Insert Image
 * dialog: Markdown image or HTML <img>, alt text, size and position.
 */
export class ImageInsertModal extends Modal {
  private decided = false;
  private mode: 'markdown' | 'html' = 'markdown';
  private altText: string;
  private sizeMode: ImageSizeMode = 'width';
  private sizeValue: string;
  private position: ImagePosition = 'inline';

  constructor(
    app: App,
    private src: string,
    defaultAlt: string,
    private intrinsic: { width: number; height: number } | undefined,
    private resolve: (decision: ImageInsertDecision | null) => void
  ) {
    super(app);
    this.altText = defaultAlt;
    this.sizeValue = intrinsic ? String(intrinsic.width) : '';
  }

  onOpen(): void {
    this.titleEl.setText('Insert image');
    const { contentEl } = this;
    contentEl.addClass('mdz-image-insert');
    contentEl.createEl('p', { text: `Choose the Markdown inserted for ${this.src}.`, cls: 'setting-item-description' });

    const htmlOnly: Setting[] = [];
    const refresh = () => {
      const html = this.mode === 'html';
      for (const s of htmlOnly) {
        s.setDisabled(!html);
        s.settingEl.toggleClass('mdz-field-disabled', !html);
      }
      sizeText.inputEl.disabled = !html || this.sizeMode === 'original';
    };

    new Setting(contentEl).setName('Output').addDropdown((d) =>
      d
        .addOption('markdown', 'Markdown image')
        .addOption('html', 'HTML <img> with sizing')
        .setValue(this.mode)
        .onChange((v) => {
          this.mode = v as 'markdown' | 'html';
          refresh();
        })
    );
    new Setting(contentEl).setName('Alt text').addText((t) =>
      t.setValue(this.altText).onChange((v) => (this.altText = v))
    );

    let sizeText!: { inputEl: HTMLInputElement; setValue(v: string): unknown };
    const size = new Setting(contentEl)
      .setName('Size')
      .setDesc(this.intrinsic ? `Original: ${this.intrinsic.width} × ${this.intrinsic.height}` : '')
      .addDropdown((d) =>
        d
          .addOption('original', 'Original size')
          .addOption('width', 'Width')
          .addOption('height', 'Height')
          .addOption('percent', 'Percent')
          .setValue(this.sizeMode)
          .onChange((v) => {
            this.sizeMode = v as ImageSizeMode;
            // Like mdzip-editor: switching starts from the image's own size (or 100%).
            this.sizeValue =
              v === 'width' ? String(this.intrinsic?.width ?? '') : v === 'height' ? String(this.intrinsic?.height ?? '') : v === 'percent' ? '100' : '';
            sizeText.setValue(this.sizeValue);
            refresh();
          })
      )
      .addText((t) => {
        sizeText = t;
        t.inputEl.type = 'number';
        t.inputEl.min = '1';
        t.inputEl.addClass('mdz-image-size');
        t.setValue(this.sizeValue).onChange((v) => (this.sizeValue = v));
      });
    htmlOnly.push(size);

    const position = new Setting(contentEl).setName('Position').addDropdown((d) =>
      d
        .addOption('inline', 'Inline/default')
        .addOption('left', 'Left')
        .addOption('center', 'Center')
        .addOption('right', 'Right')
        .addOption('wrap-left', 'Wrap left')
        .addOption('wrap-right', 'Wrap right')
        .setValue(this.position)
        .onChange((v) => (this.position = v as ImagePosition))
    );
    htmlOnly.push(position);

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('Insert')
          .setCta()
          .onClick(() => this.finish())
      );
    this.scope.register([], 'Enter', () => {
      this.finish();
      return false;
    });
    refresh();
  }

  private finish(): void {
    const html = this.mode === 'html';
    const dims = html ? imageSize(this.sizeMode, Number(this.sizeValue), this.intrinsic) : {};
    this.decided = true;
    this.resolve({ mode: this.mode, altText: this.altText, ...dims, position: html ? this.position : 'inline' });
    this.close();
  }

  onClose(): void {
    if (!this.decided) this.resolve(null);
    this.contentEl.empty();
  }
}

/**
 * The markup for one inserted image, by the "Images pasted into archives"
 * setting: Markdown, HTML with the image's own size, or the dialog. Null if
 * the dialog was cancelled (the image is then left out).
 */
export async function imageMarkup(
  app: App,
  mode: ImageInsertMode,
  src: string,
  image: Blob,
  defaultAlt: string
): Promise<string | null> {
  if (mode === 'markdown') return formatImage(src, { mode: 'markdown', altText: defaultAlt });
  if (mode === 'html') return formatImage(src, { mode: 'html', altText: defaultAlt, position: 'inline' });
  const intrinsic = await intrinsicSize(image);
  const decision = await new Promise<ImageInsertDecision | null>((resolve) =>
    new ImageInsertModal(app, src, defaultAlt, intrinsic, resolve).open()
  );
  return decision ? formatImage(src, decision) : null;
}
