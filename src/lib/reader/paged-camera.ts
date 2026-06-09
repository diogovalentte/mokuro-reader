/**
 * Transform camera for the paged reader — the ZoomSurface behind paged mode.
 *
 * Owns `translate(x, y) scale(s)` (origin 0 0) on the wrapper element the
 * old panzoom library used to control, where `s = baseScale × userZoom`.
 * The base comes from page data via paged-zoom-layout's baseTransform; the
 * controller drives userZoom and per-frame view corrections.
 *
 * Invariant: clamping runs after EVERY mutation (scale-only writes shrink
 * the bounds before any correction arrives, and anchorless paths never call
 * correctView at all). Axes where the scaled content fits lock to the mode's
 * alignment recomputed from the current scaled size. Clamping is gated by
 * the user's bounds/mobile settings — disabled means free panning, exactly
 * like the old keepInBounds no-op.
 */

import { Animator } from './animator';
import {
  alignPosition,
  clampTranslate,
  panEdgeState,
  type BaseLayout,
  type Size,
  type Translate
} from './paged-zoom-layout';
import type { ZoomSurface } from './zoom-controller';

export interface PagedCameraConfig {
  getWrapper(): HTMLElement | null | undefined;
  getViewport(): Size;
  /** bounds/mobile settings gate — false means free panning, no clamping. */
  isClampingEnabled(): boolean;
  getDevicePixelRatio?(): number;
}

export class PagedCamera {
  private config: PagedCameraConfig;
  private content: Size | null = null;
  private base: BaseLayout = { scale: 1, x: 0, y: 0, alignX: 'center', alignY: 'center' };
  private userZoom = 1;
  private tx = 0;
  private ty = 0;
  private panX: Animator;
  private panY: Animator;

  constructor(config: PagedCameraConfig) {
    this.config = config;
    this.panX = new Animator(
      0,
      (v) => {
        this.tx = v;
        this.clampAndRender(false);
      },
      { factor: 0.22, epsilon: 0.5 }
    );
    this.panY = new Animator(
      0,
      (v) => {
        this.ty = v;
        this.clampAndRender(false);
      },
      { factor: 0.22, epsilon: 0.5, onSettle: () => this.settle() }
    );
  }

  get translate(): Translate {
    return { x: this.tx, y: this.ty };
  }

  get effectiveScale(): number {
    return this.base.scale * this.userZoom;
  }

  get currentUserZoom(): number {
    return this.userZoom;
  }

  get baseScale(): number {
    return this.base.scale;
  }

  private scaledSize(): Size {
    const c = this.content ?? { width: 0, height: 0 };
    const s = this.effectiveScale;
    return { width: c.width * s, height: c.height * s };
  }

  /**
   * Set the displayed content (from page data, not DOM measurement) and its
   * mode base, placing the view at the base alignment for the current user
   * zoom. Callers reset or convert the user zoom level beforehand (keepZoom
   * preserves effective scale; other modes reset to 1).
   */
  applyBase(content: Size, base: BaseLayout): void {
    this.content = content;
    this.base = base;
    this.stopPan();
    const scaled = this.scaledSize();
    const viewport = this.config.getViewport();
    this.tx = alignPosition(base.alignX, scaled.width, viewport.width);
    this.ty = alignPosition(base.alignY, scaled.height, viewport.height);
    this.clampAndRender(true);
  }

  /** Set the user zoom multiplier (controller frame step). Clamps and renders. */
  setUserZoom(zoom: number): void {
    this.userZoom = zoom;
    this.clampAndRender(true);
  }

  /**
   * Relative view correction in screen space — the paged equivalent of a
   * scroll write: moving content left/up by (dx, dy) decreases the translate.
   */
  adjustView(dx: number, dy: number): void {
    this.tx -= dx;
    this.ty -= dy;
    this.syncPan();
    this.clampAndRender(false);
  }

  /** Smoothly pan by a delta (arrow keys, wheel-pan). Targets are clamped. */
  panBy(dx: number, dy: number): void {
    const target = this.clamped({ x: this.panX.target + dx, y: this.panY.target + dy });
    this.panX.setTarget(target.x);
    this.panY.setTarget(target.y);
  }

  /** Stop pan animations, keeping the current position. */
  stopPan(): void {
    this.panX.stop();
    this.panY.stop();
    this.syncPan();
  }

  /** Adopt the current translate as the pan animators' state. */
  private syncPan(): void {
    this.panX.current = this.tx;
    this.panX.target = this.tx;
    this.panY.current = this.ty;
    this.panY.target = this.ty;
  }

  /**
   * Round the settled translate to device pixels — fractional translates
   * produce a 1-px white compositor seam in Chrome (#65).
   */
  settle(): void {
    const dpr = this.config.getDevicePixelRatio?.() ?? 1;
    this.tx = Math.round(this.tx * dpr) / dpr;
    this.ty = Math.round(this.ty * dpr) / dpr;
    this.syncPan();
    this.clampAndRender(false);
  }

  /** Hidden-content edge state for swipe-to-flip gating (issue #186). */
  edgeState(): { canRevealLeft: boolean; canRevealRight: boolean } {
    return panEdgeState(this.translate, this.scaledSize(), this.config.getViewport());
  }

  /** The controller-facing surface: user zoom in, view corrections out. */
  surface(): ZoomSurface {
    return {
      isReady: () => !!this.config.getWrapper() && !!this.content,
      applyZoomLayout: (zoom) => this.setUserZoom(zoom),
      syncLayout: () => {
        // Transforms don't relayout; getBoundingClientRect always sees them.
      },
      correctView: (dx, dy) => this.adjustView(dx, dy)
    };
  }

  destroy(): void {
    this.panX.destroy();
    this.panY.destroy();
  }

  private clamped(translate: Translate): Translate {
    if (!this.config.isClampingEnabled() || !this.content) return translate;
    return clampTranslate(translate, this.scaledSize(), this.config.getViewport(), {
      x: this.base.alignX,
      y: this.base.alignY
    });
  }

  private clampAndRender(resyncPan: boolean): void {
    const c = this.clamped({ x: this.tx, y: this.ty });
    this.tx = c.x;
    this.ty = c.y;
    if (resyncPan) this.syncPan();

    const wrapper = this.config.getWrapper();
    if (!wrapper) return;
    wrapper.style.transformOrigin = '0 0';
    wrapper.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.effectiveScale})`;
  }
}
