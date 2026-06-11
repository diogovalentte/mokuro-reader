<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '$lib/settings';
  import { PagedCamera } from '$lib/reader/paged-camera';
  import { ContinuousZoomController } from '$lib/reader/zoom-controller';
  import type { Size } from '$lib/reader/paged-zoom-layout';
  import {
    applyPagedBase,
    createSessionState,
    doubleTapTarget,
    pagedLevels
  } from '$lib/reader/paged-zoom-session';
  import { normalizeWheelDelta, wheelIntentIsZoom } from '$lib/reader/zoom-math';
  import { pagedZoom, type PagedZoomApi } from '$lib/reader/paged-zoom';
  import { PointerGestureTracker } from '$lib/reader/input/pointer-tracker';
  import { gestureTargetRole } from '$lib/reader/input/gesture-target';

  interface Props {
    /** Native pixel size of the displayed page or pair — from page data, not DOM. */
    contentSize: Size;
    /**
     * Identity of the displayed content (e.g. the page index). Manga pages
     * are overwhelmingly uniform in size, so the base must re-apply on page
     * turns even when the dimensions don't change.
     */
    pageKey: number | string;
    rtl: boolean;
    children?: Snippet;
  }

  let { contentSize, pageKey, rtl, children }: Props = $props();

  let wrapperEl: HTMLDivElement | undefined = $state();
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

  // Session state for the controller's dynamic level ladder (plain object —
  // read by closures at call time, never rendered).
  const session = createSessionState();

  const camera = new PagedCamera({
    getWrapper: () => wrapperEl,
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    isClampingEnabled: () => $settings.bounds || $settings.mobile,
    getDevicePixelRatio: () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  });

  const controller = new ContinuousZoomController({
    surface: camera.surface(),
    getLevels: () => pagedLevels(session.baseScale, session.fitScale),
    getPageElements: () => {
      // During a {#key page} transition both the outgoing and incoming trees
      // are in the DOM; anchor only to the live (last) tree's pages.
      if (!wrapperEl) return [];
      const all = [...wrapperEl.querySelectorAll<HTMLElement>('[data-page-index]')];
      if (all.length === 0) return all;
      const liveTree = all[all.length - 1].closest('.col-start-1');
      return liveTree ? all.filter((el) => el.closest('.col-start-1') === liveTree) : all;
    },
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    onSettled: () => camera.settle()
  });

  function applyBase(mode: string) {
    applyPagedBase(
      { camera, controller, state: session },
      mode,
      contentSize,
      { width: viewportWidth, height: viewportHeight },
      rtl
    );
  }

  // Re-apply on page-identity / content / mode / viewport / direction
  // changes. The base is computed from page data, so the {#key page}
  // transition overlap can't skew it; pageKey makes uniform-dimension page
  // turns (the normal manga case) re-apply too.
  let lastSig = '';
  $effect(() => {
    const mode = $settings.zoomDefault as string;
    const sig = `${pageKey}|${contentSize.width}x${contentSize.height}|${mode}|${viewportWidth}x${viewportHeight}|${rtl}`;
    if (sig === lastSig) return;
    lastSig = sig;
    applyBase(mode);
  });

  // Enabling bounds/mobile mid-session must clamp the current view
  // immediately — the camera reads the gate lazily, only on mutations.
  $effect(() => {
    if ($settings.bounds || $settings.mobile) camera.settle();
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
    const levels = pagedLevels(session.baseScale, session.fitScale);
    const target = doubleTapTarget(controller.currentZoom, levels[0]);
    camera.stopPan();
    // Zooming in animates the tapped content toward the CLAMPED center
    // position — aiming at the raw center fights the bounds near edges.
    controller.animateToLevel(
      target,
      { x, y },
      target >= 2 ? camera.projectCentered({ x, y }, target) : { x, y }
    );
  }

  function scrollImage(direction: 'up' | 'down') {
    // A running zoom animation owns the camera — finish it first or its
    // per-frame corrections stomp the pan.
    if (controller.isActive) controller.finishNow();
    const amount = viewportHeight * 0.75;
    camera.panBy(0, direction === 'down' ? -amount : amount);
  }

  function zoomFitToScreen() {
    // Show the whole page without changing the persisted mode — the next
    // page turn re-applies the user's zoomDefault.
    applyPagedBase(
      { camera, controller, state: session },
      'zoomFitToScreen',
      contentSize,
      { width: viewportWidth, height: viewportHeight },
      rtl
    );
  }

  const api: PagedZoomApi = {
    handleWheel,
    doubleTap,
    scrollImage,
    edgeState: () => camera.edgeState(),
    zoomFitToScreen
  };

  // ============================================================
  // Pointer gestures — classification lives in PointerGestureTracker
  // (src/lib/reader/input/pointer-tracker.ts); this config holds only the
  // paged surface's policy:
  //
  // - capture 'deferred': gutter-button clicks and text-selection drags
  //   deliver natively; capture engages only once a drag crosses threshold
  // - mouse/pen on a text box is a selection drag, never a pan; touch has no
  //   drag-selection gesture, so touch pans everywhere (exactly like the old
  //   panzoom touch path) and COEXISTS with Reader's window-level
  //   swipe-to-flip, which stays edge-gated (#186)
  // - pan deltas are incremental — the camera accumulates them
  // - isPinchAlive lets the tracker resurrect a pinch whose controller state
  //   was cleared mid-gesture by a base re-application (rotation, page turn)
  // ============================================================

  const tracker = new PointerGestureTracker({
    getElement: () => wrapperEl,
    capturePolicy: 'deferred',
    suppressPan: (e) => e.pointerType !== 'touch' && gestureTargetRole(e.target) === 'textbox',
    onPress: () => {
      if (controller.isActive) controller.finishNow();
      camera.stopPan();
    },
    onPanMove: (_p, d) => camera.adjustView(-d.dx, -d.dy),
    onPanEnd: (s) => {
      if (s.panned) camera.settle();
    },
    onPinchStart: (pts) => {
      camera.stopPan();
      controller.pinchStart(pts);
    },
    onPinchMove: (pts) => controller.pinchMove(pts),
    onPinchEnd: () => controller.pinchEnd(),
    // The finger remaining after a pinch keeps panning (the old panzoom
    // pinch→drag handoff) — safe here because deltas are incremental.
    pinchSurvivorPans: true,
    isPinchAlive: () => controller.isActive,
    // Safari desktop trackpad pinch. A gesture at exactly x=0 falls back to
    // center — indistinguishable from WebKit omitting the coordinate.
    safariGestures: {
      start: (x, y) => {
        camera.stopPan();
        controller.gestureStart(x || viewportWidth / 2, y || viewportHeight / 2);
      },
      change: (scale, x, y) =>
        controller.gestureChange(scale, x || viewportWidth / 2, y || viewportHeight / 2),
      end: () => controller.gestureEnd()
    }
  });

  onMount(() => {
    pagedZoom.set(api);
    tracker.attach();
  });

  onDestroy(() => {
    pagedZoom.set(undefined);
    tracker.detach();
    controller.destroy();
    camera.destroy();
  });
</script>

<svelte:window onresize={handleResize} />

<div bind:this={wrapperEl} data-mokuro-reader style:touch-action="none" role="none">
  {@render children?.()}
</div>
