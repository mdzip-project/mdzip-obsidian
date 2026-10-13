// The Markdown or HTML written for an inserted image. Matches mdzip-editor's
// Insert Image dialog (used by MDZip Studio and the VS Code extension), so an
// archive edited in any of them gets the same markup: `![alt](path)`, or
// `<img>` with width/height and alignment. Alignment uses `align` attributes,
// not inline `style`, because preview sanitizers keep `align` and strip `style`.
// Kept free of Obsidian imports so it can be tested on its own.

/** How pasted or dropped images are inserted (as mdzip-editor's `imageInsertMode`). */
export type ImageInsertMode = 'markdown' | 'ask' | 'html';

export type ImagePosition = 'inline' | 'left' | 'center' | 'right' | 'wrap-left' | 'wrap-right';

export interface ImageInsertDecision {
  mode: 'markdown' | 'html';
  altText: string;
  width?: number;
  height?: number;
  position?: ImagePosition;
}

export type ImageSizeMode = 'original' | 'width' | 'height' | 'percent';

// Both escapes are exactly mdzip-editor's (workspace-view.ts, image-edit.ts).
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Alt text that can't end the `[...]` early. */
export function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

/** The markup for an image at archive-relative `src`. */
export function formatImage(src: string, decision: ImageInsertDecision): string {
  if (decision.mode === 'html') {
    const attrs = [`src="${escapeHtml(src)}"`, `alt="${escapeHtml(decision.altText)}"`];
    if (decision.width) attrs.push(`width="${decision.width}"`);
    if (decision.height) attrs.push(`height="${decision.height}"`);
    if (decision.position === 'wrap-left' || decision.position === 'wrap-right') {
      attrs.push(`align="${decision.position === 'wrap-left' ? 'left' : 'right'}"`);
    }
    const image = `<img ${attrs.join(' ')}>`;
    if (decision.position === 'left' || decision.position === 'center' || decision.position === 'right') {
      return `<p align="${decision.position}">${image}</p>`;
    }
    return image;
  }
  return `![${escapeMarkdownImageAlt(decision.altText)}](${src})`;
}

/**
 * Width and height for a size choice, as mdzip-editor computes them:
 * width or height alone, or both from a percentage of the image's real size.
 */
export function imageSize(
  sizeMode: ImageSizeMode,
  value: number | undefined,
  intrinsic?: { width: number; height: number }
): { width?: number; height?: number } {
  if (!value || !(value > 0)) return {};
  const v = Math.round(value);
  if (sizeMode === 'width') return { width: v };
  if (sizeMode === 'height') return { height: v };
  if (sizeMode === 'percent' && intrinsic?.width && intrinsic.height) {
    return {
      width: Math.max(1, Math.round((intrinsic.width * v) / 100)),
      height: Math.max(1, Math.round((intrinsic.height * v) / 100)),
    };
  }
  return {};
}
