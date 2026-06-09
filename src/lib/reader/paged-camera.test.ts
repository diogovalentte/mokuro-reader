import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PagedCamera } from './paged-camera';
import { baseTransform } from './paged-zoom-layout';

const viewport = { width: 1600, height: 900 };

function makeWrapper() {
  return { style: { transform: '', transformOrigin: '' } } as unknown as HTMLElement;
}

function makeCamera(opts?: { clamp?: boolean; dpr?: number }) {
  const wrapper = makeWrapper();
  const camera = new PagedCamera({
    getWrapper: () => wrapper,
    getViewport: () => viewport,
    isClampingEnabled: () => opts?.clamp ?? true,
    getDevicePixelRatio: () => opts?.dpr ?? 1
  });
  return { camera, wrapper };
}

/** Deterministic rAF pump for the pan Animators. */
let rafQueue: FrameRequestCallback[] = [];
let clock = 0;

function pump(frames = 80, dt = 16.67) {
  for (let i = 0; i < frames && rafQueue.length > 0; i++) {
    clock += dt;
    const cbs = rafQueue.splice(0);
    for (const cb of cbs) cb(clock);
  }
}

beforeEach(() => {
  rafQueue = [];
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tall = { width: 700, height: 1000 };

describe('PagedCamera — base application', () => {
  it('places content at the base transform and renders it', () => {
    const { camera, wrapper } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));

    expect(camera.translate.x).toBeCloseTo((1600 - 630) / 2, 4);
    expect(camera.translate.y).toBeCloseTo(0, 4);
    expect(camera.effectiveScale).toBeCloseTo(0.9, 6);
    expect(wrapper.style.transformOrigin).toBe('0 0');
    expect(wrapper.style.transform).toContain('scale(0.9)');
  });

  it('keeps the user zoom and re-places at the alignment when asked', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('keepZoom', tall, viewport, true));
    camera.setUserZoom(2);
    // RTL keepZoom: end-aligned X — at 2x (1260 wide, fits) lock stays flush right
    expect(camera.translate.x).toBeCloseTo(1600 - 700 * 0.9 * 2, 4);
    expect(camera.effectiveScale).toBeCloseTo(1.8, 6);
  });
});

describe('PagedCamera — clamping invariant', () => {
  it('clamps on scale-only writes (zooming out at an edge shrinks the bounds)', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(3); // 1890x2700, overflows both axes
    camera.adjustView(2000, 3000); // pan past the bottom-right corner — clamps at the edges
    const atEdgeY = camera.translate.y;
    expect(atEdgeY).toBeCloseTo(900 - 2700, 1);

    camera.setUserZoom(1.5); // shrink: old translate now far out of bounds
    expect(camera.translate.y).toBeGreaterThanOrEqual(900 - 1000 * 0.9 * 1.5);
    expect(camera.translate.x).toBeCloseTo((1600 - 700 * 0.9 * 1.5) / 2, 4); // fitting axis re-locks
  });

  it('passes corrections through unclamped when clamping is disabled', () => {
    const { camera } = makeCamera({ clamp: false });
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.adjustView(-5000, -5000); // free pan mode: way out of bounds is allowed
    expect(camera.translate.x).toBeCloseTo((1600 - 630) / 2 + 5000, 4);
    expect(camera.translate.y).toBeCloseTo(5000, 4);
  });

  it('clamps corrections at the content edges when enabled', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(2); // 1260x1800: x fits (locks center), y overflows
    camera.adjustView(500, -4000);
    expect(camera.translate.x).toBeCloseTo((1600 - 1260) / 2, 4);
    expect(camera.translate.y).toBe(0); // clamped at the top edge
  });
});

describe('PagedCamera — panning', () => {
  it('smooth pan eases to a clamped target', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(2);

    camera.panBy(0, -2000); // scroll down further than the range allows
    pump();
    expect(camera.translate.y).toBeCloseTo(900 - 1800, 1); // clamped end
  });

  it('rounds the settled translate to device pixels (compositor seam, #65)', () => {
    const { camera } = makeCamera({ dpr: 2 });
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    camera.setUserZoom(2);
    camera.adjustView(333.337, 333.331);
    camera.settle();
    expect(camera.translate.y * 2).toBeCloseTo(Math.round(camera.translate.y * 2), 6);
  });

  it('reports edge state for swipe-to-flip gating', () => {
    const { camera } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    expect(camera.edgeState()).toEqual({ canRevealLeft: false, canRevealRight: false });

    camera.setUserZoom(3); // 1890 wide
    camera.adjustView(-10000, 0); // fully right (x -> 0)
    const s = camera.edgeState();
    expect(s.canRevealLeft).toBe(false);
    expect(s.canRevealRight).toBe(true);
  });
});

describe('PagedCamera — ZoomSurface', () => {
  it('implements the controller surface over user zoom', () => {
    const { camera, wrapper } = makeCamera();
    camera.applyBase(tall, baseTransform('zoomFitToScreen', tall, viewport, true));
    const surface = camera.surface();

    expect(surface.isReady()).toBe(true);
    surface.applyZoomLayout(2);
    expect(camera.effectiveScale).toBeCloseTo(1.8, 6);
    surface.correctView(100, 200);
    expect(wrapper.style.transform).toContain('scale(1.8');
  });

  it('is not ready before content is set', () => {
    const { camera } = makeCamera();
    expect(camera.surface().isReady()).toBe(false);
  });
});
