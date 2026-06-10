/**
 * The paged-mode zoom API surface, registered by PagedViewport while mounted.
 *
 * Replaces the old module-level panzoom singleton (panzoomStore & friends).
 * Kept dependency-free (svelte/store + types only) so settings-layer modules
 * never need to import reader internals — consumers subscribe and call.
 */

import { writable } from 'svelte/store';

export interface PagedZoomApi {
  /** Window-level wheel delegate (zoom intent or smooth vertical pan). */
  handleWheel(e: WheelEvent): void;
  /** Contextual double-tap: 1 ↔ fit ↔ 2× (see paged-zoom-session). */
  doubleTap(x: number, y: number): void;
  /** Arrow-key style smooth vertical pan (75% of the viewport). */
  scrollImage(direction: 'up' | 'down'): void;
  /** Hidden-content edge state for swipe-to-flip gating (issue #186). */
  edgeState(): { canRevealLeft: boolean; canRevealRight: boolean };
  /** QuickActions: show the whole page (fit-to-screen view, level 1). */
  zoomFitToScreen(): void;
}

/** Set while a paged reader is mounted; undefined in continuous mode. */
export const pagedZoom = writable<PagedZoomApi | undefined>(undefined);
