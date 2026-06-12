/**
 * Pure layout math for the paged-mode zoom camera — no DOM, fully testable.
 *
 * Paged mode positions its content with `translate(x, y) scale(s)` (origin
 * 0 0) on a wrapper element. A *base transform* fits the displayed page(s)
 * to the viewport per the user's zoom mode; user zoom multiplies the base
 * scale and the camera clamps panning so content edges never drift past the
 * viewport edges (replacing the old panzoom keepInBounds()).
 *
 * Axes where the scaled content fits inside the viewport lock to the mode's
 * ALIGNMENT RULE recomputed from the current scaled size — never to the
 * level-1 position, which would mis-place every zoomed frame where an axis
 * still fits (and, end-aligned, push content past the viewport edge).
 *
 * The e2e suite imports this module through the Vite dev server and drives
 * the real functions — keep it free of Svelte and component state.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Translate {
  x: number;
  y: number;
}

export type Align = 'start' | 'center' | 'end';

export interface BaseLayout extends Translate {
  scale: number;
  alignX: Align;
  alignY: Align;
}

export type PagedZoomMode =
  | 'zoomFitToScreen'
  | 'zoomFitToWidth'
  | 'zoomOriginal'
  | 'keepZoom'
  // Legacy persisted aliases (localStorage / synced profiles) — keepZoom.
  | 'keepZoomStart'
  | 'keepZoomTopCorner';

/** Tolerance for sub-pixel pan values ("within a pixel of the edge" counts). */
const EDGE_EPSILON = 1;

/** Position of one axis for an alignment rule at the current scaled size. */
export function alignPosition(align: Align, scaled: number, viewport: number): number {
  if (align === 'center') return (viewport - scaled) / 2;
  if (align === 'end') return viewport - scaled;
  return 0;
}

/**
 * The mode's fitted layout for the displayed content: base scale, the level-1
 * position, and the per-axis alignment rules that fitting axes lock to at any
 * user zoom.
 *
 * - fit-to-screen: limiting-axis fit, centered both axes
 * - fit-to-width: fill viewport width, top-aligned
 * - original: 1:1 at the reading-start corner (right in RTL), top-aligned
 * - keepZoom (+legacy aliases): fit-to-screen scale at the reading-start
 *   corner — the preserved effective scale multiplies this base across pages
 *
 * Accepts arbitrary strings because zoom modes are persisted in localStorage
 * and synced profiles that may carry values from other app versions; unknown
 * values resolve to fit-to-screen.
 */
export function baseTransform(
  mode: PagedZoomMode | string,
  content: Size,
  viewport: Size,
  rtl: boolean
): BaseLayout {
  if (content.width <= 0 || content.height <= 0) {
    return { scale: 1, x: 0, y: 0, alignX: 'center', alignY: 'center' };
  }

  const fitScale = Math.min(viewport.width / content.width, viewport.height / content.height);
  const corner: Align = rtl ? 'end' : 'start';

  let scale: number;
  let alignX: Align;
  let alignY: Align;

  switch (mode) {
    case 'zoomFitToWidth':
      scale = viewport.width / content.width;
      alignX = 'center';
      alignY = 'start';
      break;
    case 'zoomOriginal':
      scale = 1;
      alignX = corner;
      alignY = 'start';
      break;
    case 'keepZoom':
    case 'keepZoomStart':
    case 'keepZoomTopCorner':
      scale = fitScale;
      alignX = corner;
      alignY = 'start';
      break;
    case 'zoomFitToScreen':
    default:
      scale = fitScale;
      alignX = 'center';
      alignY = 'center';
      break;
  }

  return {
    scale,
    alignX,
    alignY,
    x: alignPosition(alignX, content.width * scale, viewport.width),
    y: alignPosition(alignY, content.height * scale, viewport.height)
  };
}

/**
 * Clamp a translate so content edges never pass viewport edges. Axes where
 * the scaled content fits lock to their alignment position at the current
 * scaled size. Non-finite inputs collapse into bounds — a NaN write would
 * teleport the camera.
 */
export function clampTranslate(
  translate: Translate,
  scaledContent: Size,
  viewport: Size,
  align: { x: Align; y: Align }
): Translate {
  const clampAxis = (value: number, scaled: number, view: number, rule: Align): number => {
    if (scaled <= view + EDGE_EPSILON) return alignPosition(rule, scaled, view);
    const v = Number.isFinite(value) ? value : alignPosition(rule, scaled, view);
    return Math.max(view - scaled, Math.min(0, v));
  };

  return {
    x: clampAxis(translate.x, scaledContent.width, viewport.width, align.x),
    y: clampAxis(translate.y, scaledContent.height, viewport.height, align.y)
  };
}

/**
 * Whether content remains hidden beyond the left/right viewport edges at the
 * current pan position. The mobile swipe handler uses this to distinguish
 * "pan across the page" from "swipe to flip pages" (issue #186) — semantics
 * identical to the old getHorizontalPanEdgeState().
 */
export function panEdgeState(
  translate: Translate,
  scaledContent: Size,
  viewport: Size
): { canRevealLeft: boolean; canRevealRight: boolean } {
  if (scaledContent.width <= viewport.width) {
    return { canRevealLeft: false, canRevealRight: false };
  }
  const minX = viewport.width - scaledContent.width;
  return {
    canRevealLeft: translate.x < 0 - EDGE_EPSILON,
    canRevealRight: translate.x > minX + EDGE_EPSILON
  };
}
