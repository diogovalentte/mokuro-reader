<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '$lib/settings';
  import { PagedCamera } from '$lib/reader/paged-camera';
  import { ContinuousZoomController } from '$lib/reader/zoom-controller';
  import { baseTransform, type Size } from '$lib/reader/paged-zoom-layout';
  import {
    convertLevelAcrossBases,
    doubleTapTarget,
    pagedLevels
  } from '$lib/reader/paged-zoom-session';
  import { normalizeWheelDelta, wheelIntentIsZoom } from '$lib/reader/zoom-math';
  import { pagedZoom, type PagedZoomApi } from '$lib/reader/paged-zoom';

  interface Props {
    /** Native pixel size of the displayed page or pair — from page data, not DOM. */
    contentSize: Size;
    rtl: boolean;
    children?: Snippet;
  }

  let { contentSize, rtl, children }: Props = $props();

  let wrapperEl: HTMLDivElement | undefined = $state();
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

  // Session state for the controller's dynamic level ladder (plain vars —
  // read by closures at call time, never rendered).
  let baseScale = 1;
  let fitScale = 1;
  let initialized = false;

  const camera = new PagedCamera({
    getWrapper: () => wrapperEl,
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    isClampingEnabled: () => $settings.bounds || $settings.mobile,
    getDevicePixelRatio: () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  });

  const controller = new ContinuousZoomController({
    surface: camera.surface(),
    getLevels: () => pagedLevels(baseScale, fitScale),
    getPageElements: () =>
      wrapperEl ? [...wrapperEl.querySelectorAll<HTMLElement>('[data-page-index]')] : [],
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    onSettled: () => camera.settle()
  });

  /**
   * Apply the mode base for the current content/viewport. keepZoom converts
   * the user level so the effective on-screen scale is preserved (page
   * turns, spreads, resize, and KeyZ entry alike); other modes reset to 1.
   * Always instant — never animated.
   */
  function applyBase(mode: string) {
    if (!(contentSize.width > 0) || !(contentSize.height > 0)) return;
    const viewport = { width: viewportWidth, height: viewportHeight };

    const oldBaseScale = baseScale;
    const oldLevel = controller.currentZoom;
    controller.finishNow();

    const base = baseTransform(mode, contentSize, viewport, rtl);
    fitScale = Math.min(viewport.width / contentSize.width, viewport.height / contentSize.height);
    baseScale = base.scale;

    const levels = pagedLevels(baseScale, fitScale);
    const floor = levels[0];
    const top = levels[levels.length - 1];
    const isKeep = mode === 'keepZoom' || mode === 'keepZoomStart' || mode === 'keepZoomTopCorner';
    const level =
      isKeep && initialized
        ? convertLevelAcrossBases(oldLevel, oldBaseScale, baseScale, floor, top)
        : 1;

    camera.applyBase(contentSize, base);
    controller.snapToLevel(level);
    camera.place();
    initialized = true;
  }

  // Re-apply on content / mode / viewport / direction changes. The base is
  // computed from page data, so the {#key page} transition overlap (both
  // trees in the DOM for ~300 ms) can't skew it.
  let lastSig = '';
  $effect(() => {
    const mode = $settings.zoomDefault as string;
    const sig = `${contentSize.width}x${contentSize.height}|${mode}|${viewportWidth}x${viewportHeight}|${rtl}`;
    if (sig === lastSig) return;
    lastSig = sig;
    applyBase(mode);
  });

  function handleResize() {
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
  }

  // ============================================================
  // Wheel (window-level delegate — Reader routes reader-targeted events here)
  // ============================================================

  function handleWheel(e: WheelEvent) {
    const modifier = e.ctrlKey || e.metaKey;
    if (wheelIntentIsZoom(modifier, $settings.swapWheelBehavior)) {
      e.preventDefault();
      camera.stopPan();
      controller.wheelZoom(e);
      return;
    }
    e.preventDefault();
    if (controller.isActive) controller.finishNow();
    camera.panBy(0, -normalizeWheelDelta(e.deltaY, e.deltaMode));
  }

  function doubleTap(x: number, y: number) {
    const levels = pagedLevels(baseScale, fitScale);
    const target = doubleTapTarget(controller.currentZoom, levels[0]);
    camera.stopPan();
    controller.animateToLevel(
      target,
      { x, y },
      target >= 2 ? { x: viewportWidth / 2, y: viewportHeight / 2 } : { x, y }
    );
  }

  function scrollImage(direction: 'up' | 'down') {
    const amount = viewportHeight * 0.75;
    camera.panBy(0, direction === 'down' ? -amount : amount);
  }

  function zoomFitToScreen() {
    const viewport = { width: viewportWidth, height: viewportHeight };
    const base = baseTransform('zoomFitToScreen', contentSize, viewport, rtl);
    fitScale = Math.min(viewport.width / contentSize.width, viewport.height / contentSize.height);
    baseScale = base.scale;
    controller.finishNow();
    camera.applyBase(contentSize, base);
    controller.snapToLevel(1);
    camera.place();
  }

  const api: PagedZoomApi = {
    handleWheel,
    doubleTap,
    scrollImage,
    edgeState: () => camera.edgeState(),
    zoomFitToScreen
  };

  // ============================================================
  // Pointer state machine
  //
  // - every pointer enters the map; .textBox only suppresses PAN initiation
  // - single-finger touch never pans (reserved for Reader's swipe-to-flip)
  // - capture is deferred until DRAG_THRESHOLD so gutter-button clicks and
  //   text-selection drags behave exactly as before
  // - two pointers always upgrade to pinch; back down to one re-baselines
  //   as a fresh mouse/pen pan, touch returns to idle
  // ============================================================

  const DRAG_THRESHOLD = 5;
  let activePointers = new Map<number, { x: number; y: number; type: string }>();
  let panPointerId: number | null = null;
  let panMoved = false;
  let lastPanX = 0;
  let lastPanY = 0;

  function points() {
    return [...activePointers.values()];
  }

  function beginPan(e: { pointerId: number; clientX: number; clientY: number }) {
    panPointerId = e.pointerId;
    panMoved = false;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
  }

  function endPan() {
    if (panPointerId !== null && panMoved && wrapperEl) {
      try {
        wrapperEl.releasePointerCapture(panPointerId);
      } catch {
        /* ignore */
      }
      camera.settle();
    }
    panPointerId = null;
    panMoved = false;
  }

  function handlePointerDown(e: PointerEvent) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (activePointers.size >= 2) {
      // Pinch — always, even when a finger started on a text box.
      endPan();
      camera.stopPan();
      controller.pinchStart(points());
      return;
    }

    if (e.pointerType === 'touch') return; // swipe-to-flip's domain
    if ((e.target as HTMLElement).closest('.textBox')) return; // selection
    if (e.button !== 0) return;

    if (controller.isActive) controller.finishNow();
    camera.stopPan();
    beginPan(e);
  }

  function handlePointerMove(e: PointerEvent) {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    }

    if (activePointers.size >= 2) {
      controller.pinchMove(points());
      return;
    }

    if (panPointerId !== e.pointerId) return;
    const dx = e.clientX - lastPanX;
    const dy = e.clientY - lastPanY;

    if (!panMoved) {
      const fromStart = Math.hypot(dx, dy);
      if (fromStart <= DRAG_THRESHOLD) return;
      panMoved = true;
      window.getSelection()?.removeAllRanges();
      wrapperEl?.setPointerCapture(e.pointerId);
    }

    lastPanX = e.clientX;
    lastPanY = e.clientY;
    camera.adjustView(-dx, -dy);
  }

  function handlePointerUp(e: PointerEvent) {
    const had = activePointers.has(e.pointerId);
    activePointers.delete(e.pointerId);

    if (had && controller.isActive && activePointers.size >= 1) {
      if (activePointers.size >= 2) {
        controller.pinchStart(points()); // re-baseline on the new pair
      } else {
        controller.pinchEnd();
        const rest = points()[0];
        const restId = [...activePointers.keys()][0];
        if (rest && rest.type !== 'touch') {
          beginPan({ pointerId: restId, clientX: rest.x, clientY: rest.y });
        }
      }
      return;
    }
    if (activePointers.size === 0) controller.pinchEnd();

    if (panPointerId === e.pointerId) endPan();
  }

  // Safari desktop trackpad pinch (proprietary gesture events).
  interface WebKitGestureEvent extends Event {
    scale: number;
    clientX: number;
    clientY: number;
  }

  function handleGestureStart(e: Event) {
    e.preventDefault();
    const ge = e as WebKitGestureEvent;
    camera.stopPan();
    controller.gestureStart(ge.clientX ?? viewportWidth / 2, ge.clientY ?? viewportHeight / 2);
  }

  function handleGestureChange(e: Event) {
    e.preventDefault();
    const ge = e as WebKitGestureEvent;
    controller.gestureChange(
      ge.scale ?? 1,
      ge.clientX ?? viewportWidth / 2,
      ge.clientY ?? viewportHeight / 2
    );
  }

  function handleGestureEnd(e: Event) {
    e.preventDefault();
    controller.gestureEnd();
  }

  onMount(() => {
    pagedZoom.set(api);
    wrapperEl?.addEventListener('gesturestart', handleGestureStart);
    wrapperEl?.addEventListener('gesturechange', handleGestureChange);
    wrapperEl?.addEventListener('gestureend', handleGestureEnd);
  });

  onDestroy(() => {
    pagedZoom.set(undefined);
    wrapperEl?.removeEventListener('gesturestart', handleGestureStart);
    wrapperEl?.removeEventListener('gesturechange', handleGestureChange);
    wrapperEl?.removeEventListener('gestureend', handleGestureEnd);
    controller.destroy();
    camera.destroy();
  });
</script>

<svelte:window onresize={handleResize} />

<div
  bind:this={wrapperEl}
  data-mokuro-reader
  style:touch-action="none"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  role="none"
>
  {@render children?.()}
</div>
