/**
 * Tap vs double-tap discrimination for reader surfaces — the timing logic
 * both scroll readers previously duplicated inline (lastTapTime +
 * setTimeout dances).
 *
 * Deferred commit: a single tap is held for the double-tap window and only
 * commits (onTap — overlay toggle) if no second tap lands; a second tap
 * within the window cancels it and fires onDoubleTap (zoom toggle) instead.
 * The cost is intentional: the overlay appears doubleTapDelayMs late so a
 * double-tap never flashes it.
 *
 * The caller reports only qualified taps — clicks already filtered by
 * target role ('page' only) and by the tracker's wasDrag. One exception is
 * handled here because it spans events: after interacting with a text box,
 * the first tap outside is a DISMISSAL (the box closes) and must not toggle
 * anything. Surfaces call noteTextBoxInteraction() when a press lands on a
 * text box; the next tap is swallowed.
 */

export interface TapDiscriminatorConfig {
  /** Double-tap window in ms. */
  doubleTapDelayMs?: number;
  /** A lone tap, fired after the window closes. */
  onTap?(x: number, y: number): void;
  /** Second tap within the window, at the second tap's position. */
  onDoubleTap?(x: number, y: number): void;
}

export class TapDiscriminator {
  private config: TapDiscriminatorConfig;
  private lastTapTime: number | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private swallowNext = false;

  constructor(config: TapDiscriminatorConfig) {
    this.config = config;
  }

  /** A press landed on a text box — the next tap dismisses, not toggles. */
  noteTextBoxInteraction(): void {
    this.swallowNext = true;
  }

  /** Report a qualified tap at viewport coordinates. */
  tap(x: number, y: number): void {
    if (this.swallowNext) {
      this.swallowNext = false;
      return;
    }

    const delay = this.config.doubleTapDelayMs ?? 300;
    const now = performance.now();

    if (this.lastTapTime !== null && now - this.lastTapTime < delay) {
      this.lastTapTime = null;
      this.clearPending();
      this.config.onDoubleTap?.(x, y);
      return;
    }

    this.lastTapTime = now;
    this.clearPending();
    this.pending = setTimeout(() => {
      this.pending = null;
      this.config.onTap?.(x, y);
    }, delay);
  }

  /** Drop any pending single tap (component teardown, page change). */
  cancel(): void {
    this.clearPending();
    this.lastTapTime = null;
    this.swallowNext = false;
  }

  private clearPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }
}
