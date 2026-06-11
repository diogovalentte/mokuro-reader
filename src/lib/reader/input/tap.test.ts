import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TapDiscriminator } from './tap';

describe('TapDiscriminator (deferred commit — scroll readers)', () => {
  let onTap: ReturnType<typeof vi.fn>;
  let onDoubleTap: ReturnType<typeof vi.fn>;
  let taps: TapDiscriminator;

  beforeEach(() => {
    vi.useFakeTimers();
    onTap = vi.fn();
    onDoubleTap = vi.fn();
    taps = new TapDiscriminator({ onTap, onDoubleTap });
  });

  afterEach(() => {
    taps.cancel();
    vi.useRealTimers();
  });

  it('commits a single tap only after the double-tap window closes', () => {
    taps.tap(100, 200);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(100, 200);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('two taps within the window fire onDoubleTap once and no onTap', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(150);
    taps.tap(110, 205);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).toHaveBeenCalledWith(110, 205);
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('two taps slower than the window are two single taps', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(400);
    taps.tap(300, 400);
    vi.advanceTimersByTime(400);
    expect(onTap).toHaveBeenCalledTimes(2);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('a tap right after a double-tap starts a fresh cycle', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(100);
    taps.tap(100, 200); // double
    vi.advanceTimersByTime(100);
    taps.tap(100, 200); // fresh first tap, not a second double
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('swallows exactly one tap after a text-box interaction', () => {
    taps.noteTextBoxInteraction();
    taps.tap(100, 200); // dismissal tap — swallowed
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();

    taps.tap(100, 200);
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('the swallowed tap does not arm a double-tap', () => {
    taps.noteTextBoxInteraction();
    taps.tap(100, 200); // swallowed
    vi.advanceTimersByTime(50);
    taps.tap(100, 200); // must be a fresh FIRST tap
    expect(onDoubleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a pending single tap', () => {
    taps.tap(100, 200);
    taps.cancel();
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('respects a custom window', () => {
    const fast = new TapDiscriminator({ onTap, onDoubleTap, doubleTapDelayMs: 100 });
    fast.tap(0, 0);
    vi.advanceTimersByTime(150);
    fast.tap(0, 0);
    expect(onDoubleTap).not.toHaveBeenCalled(); // 150ms > 100ms window
    vi.advanceTimersByTime(100);
    expect(onTap).toHaveBeenCalledTimes(2);
    fast.cancel();
  });
});
