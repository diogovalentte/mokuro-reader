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
  // Pointer state machine
  //
  // - every pointer enters the map; .textBox suppresses PAN initiation for
  //   mouse/pen only (drag selection) — touch pans everywhere, exactly like
  //   the old panzoom touch path, which handled single-finger touches
  //   unconditionally (its onTouch option only gated preventDefault)
  // - single-finger touch pan COEXISTS with Reader's swipe-to-flip: touch
  //   events aren't retargeted by pointer capture, so the window-level swipe
  //   handlers still see them and stay edge-gated (#186)
  // - capture is deferred until DRAG_THRESHOLD so gutter-button clicks and
  //   text-selection drags behave exactly as before
  // - two pointers always upgrade to pinch; back down to one re-baselines
  //   as a fresh pan with the remaining pointer
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

    // Mouse/pen on a text box is a selection drag, never a pan; touch has no
    // drag-selection gesture and panned over text in production too.
    if (e.pointerType !== 'touch' && (e.target as HTMLElement).closest('.textBox')) return;
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
      // A base re-application mid-pinch (rotation, page change) clears the
      // controller's pinch state — re-baseline on the next move so the
      // gesture stays alive instead of dying until fingers re-press.
      if (!controller.isActive) controller.pinchStart(points());
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
        // The remaining pointer continues as a pan — for touch too, matching
        // the old panzoom pinch→drag handoff.
        const rest = points()[0];
        const restId = [...activePointers.keys()][0];
        if (rest) {
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

<!-- pointerup/cancel listen on the window: an uncaptured release outside the
     wrapper (text-selection drag ending over an overlay, right-click menus)
     must still clean the pointer map, or the next mixed-input press would be
     misread as a pinch with a phantom stale point. -->
<svelte:window
  onresize={handleResize}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
/>

<div
  bind:this={wrapperEl}
  data-mokuro-reader
  style:touch-action="none"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  role="none"
>
  {@render children?.()}
</div>
