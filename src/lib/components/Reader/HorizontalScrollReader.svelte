<script lang="ts">
  import type { Page, VolumeMetadata } from '$lib/types';
  import type { VolumeSettings } from '$lib/settings/volume-data';
  import { settings, imageFilter } from '$lib/settings';
  import { matchFilesToPages } from '$lib/reader/image-cache';
  import { getCharCount } from '$lib/util/count-chars';
  import { activityTracker } from '$lib/util/activity-tracker';
  import MangaPage from './MangaPage.svelte';
  import { ScrollAnimator } from '$lib/reader/scroll-animator';
  import { ContinuousZoomController, type SettleReason } from '$lib/reader/zoom-controller';
  import { applyHorizontalAlignment, applyHorizontalZoomLayout } from '$lib/reader/zoom-layout';
  import { detectHorizontalPage, horizontalVisibilityRatio } from '$lib/reader/page-detection';
  import { normalizeWheelDelta, wheelIntentIsZoom } from '$lib/reader/zoom-math';
  import { gestureTargetRole, keyboardShouldIgnore } from '$lib/reader/input/gesture-target';
  import { onMount, onDestroy, tick } from 'svelte';

  interface Props {
    pages: Page[];
    files: Record<string, File>;
    volume: VolumeMetadata;
    volumeSettings: VolumeSettings;
    currentPage: number;
    onPageChange: (newPage: number, charCount: number, isComplete: boolean) => void;
    onVolumeNav: (direction: 'prev' | 'next') => void;
    onOverlayToggle?: () => void;
    onVisibleCountChange?: (count: number) => void;
    onContextMenu?: (data: any) => void;
  }

  let {
    pages,
    files,
    volume,
    volumeSettings,
    currentPage,
    onPageChange,
    onVolumeNav,
    onOverlayToggle,
    onVisibleCountChange,
    onContextMenu
  }: Props = $props();

  let outerDiv: HTMLDivElement | undefined = $state();
  let scrollContainer: HTMLDivElement | undefined = $state();
  let scroller: ScrollAnimator | null = null;
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);
  let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
  let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));
  let rtl = $derived(volumeSettings.rightToLeft ?? true);
  let zoomMode = $derived($settings.continuousZoomDefault);

  // Page dimensions based on zoom mode
  function pageSize(page: Page): { width: number; height: number } {
    if (zoomMode === 'zoomOriginal') {
      return { width: page.img_width, height: page.img_height };
    }
    if (zoomMode === 'zoomFitToWidth') {
      const scale = viewportWidth / page.img_width;
      return { width: viewportWidth, height: page.img_height * scale };
    }
    // zoomFitToScreen / default: fit to height
    const scale = viewportHeight / page.img_height;
    return { width: page.img_width * scale, height: viewportHeight };
  }

  // ============================================================
  // Zoom — transform scale + measurement-based scroll correction
  // ============================================================

  let zoomWrapperEl: HTMLDivElement | undefined = $state();
  let zoomSpacerEl: HTMLDivElement | undefined = $state();
  let isZoomed = $state(false);

  // Reader-specific zoomed layout (transform origin per direction, spacer
  // dims, measured cross-axis alignment) — shared with the e2e suite, see
  // zoom-layout.ts
  function applyZoomLayout(zoom: number) {
    if (!zoomWrapperEl || !zoomSpacerEl || !scrollContainer) return;
    applyHorizontalZoomLayout(
      { wrapper: zoomWrapperEl, spacer: zoomSpacerEl, container: scrollContainer },
      rtl,
      zoom
    );
  }

  function applyAlignment(zoom: number) {
    if (!zoomWrapperEl || !zoomSpacerEl || !scrollContainer) return;
    applyHorizontalAlignment(
      { wrapper: zoomWrapperEl, spacer: zoomSpacerEl, container: scrollContainer },
      zoom
    );
  }

  function handleZoomSettled(zoom: number, reason: SettleReason) {
    if (zoom <= 1 && scrollContainer) {
      // Reset the cross axis only when no scroll range legitimately remains
      // at 1× (fit-to-width/original pages taller than the viewport keep it).
      if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + 1) {
        scrollContainer.scrollTop = 0;
      }
    }
    // 'nav' settles are followed by the navigation's own navTarget update,
    // and 'reset' settles have stale scroll geometry the caller re-anchors
    // next — detection on either would land on a garbage page.
    if (reason === 'gesture' || reason === 'interrupt') {
      navTarget = detectCurrentPage();
      navIsKeyboard = false;
      reportProgress();
    }
  }

  const zoomController = new ContinuousZoomController({
    getScrollContainer: () => scrollContainer,
    getPageElements: () => pageElements,
    getViewport: () => ({ width: viewportWidth, height: viewportHeight }),
    applyZoomLayout,
    onZoomedChange: (zoomed) => {
      isZoomed = zoomed;
    },
    onSettled: handleZoomSettled
  });

  /**
   * Finish an in-flight zoom before a competing scroll intent (keyboard nav,
   * external page change) so it acts on settled geometry — the 'nav' settle
   * reason keeps it from reporting progress the navigation supersedes. The
   * scroller then adopts the corrected position (its state only syncs via
   * async scroll events; without this the next scrollBy would animate from
   * a stale position and undo the zoom's final correction).
   */
  function interruptZoomForNav() {
    if (!zoomController.isActive) return;
    zoomController.finishNow('nav');
    scroller?.sync();
    navIsKeyboard = false;
  }

  // When the zoom mode (Z key) or a layout-affecting setting changes, reset
  // any user zoom (its measured spacer/transform are stale against the new
  // layout) and stay on the current page.
  let prevLayoutKey = `${$settings.continuousZoomDefault}|${$settings.pageDividers}|${$settings.scrollGap}|${volumeSettings.rightToLeft ?? true}`;
  $effect(() => {
    const layoutKey = `${zoomMode}|${$settings.pageDividers}|${$settings.scrollGap}|${rtl}`;
    if (layoutKey === prevLayoutKey) return;
    prevLayoutKey = layoutKey;

    const pageIdx = lastReportedPage - 1;
    zoomController.reset();
    tick().then(() => {
      applyAlignment(1);
      const el = pageElements[pageIdx];
      if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
    });
  });

  // ============================================================
  // Progress tracking
  // ============================================================

  let lastReportedPage = currentPage;
  let navTarget = $state(currentPage - 1);
  let navIsKeyboard = false; // true when navTarget was set by keyboard, not scroll
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let pageElements: HTMLDivElement[] = [];

  /**
   * Detect current page: the >95% visible page whose center is closest
   * to the viewport center. Falls back to any page with center in viewport.
   * Pure rect math in visual space — correct at any zoom (page-detection.ts).
   */
  function detectCurrentPage(): number {
    if (!scrollContainer) return navTarget;
    return detectHorizontalPage(
      scrollContainer.getBoundingClientRect(),
      pageElements.map((el) => el?.getBoundingClientRect()),
      navTarget
    );
  }

  function reportProgress() {
    // Use navTarget directly — it's set by detectCurrentPage (center-most visible)
    // on manual scroll settle, or by navigateToPage on keyboard nav.
    const pageNum = Math.min(navTarget + 1, pages.length);
    if (pageNum !== lastReportedPage) {
      lastReportedPage = pageNum;
      const { charCount } = getCharCount(pages, pageNum);
      onPageChange(pageNum, charCount, pageNum >= pages.length);
    }

    // Report how many pages are visible for the page counter display
    if (onVisibleCountChange && scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      let count = 0;
      for (let i = 0; i < pageElements.length; i++) {
        const el = pageElements[i];
        if (!el) continue;
        if (horizontalVisibilityRatio(el.getBoundingClientRect(), containerRect) > 0.95) count++;
      }
      onVisibleCountChange(Math.max(count, 1));
    }
  }

  function handleScroll() {
    if (!scrollContainer) return;
    scroller?.onScroll();
    activityTracker.recordActivity();

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // Mid-zoom layout is in flux; the zoom settle hook reports instead.
      if (zoomController.isActive) return;
      // On settle, sync navTarget from DOM only if it wasn't set by keyboard
      if (!navIsKeyboard) {
        navTarget = detectCurrentPage();
      }
      navIsKeyboard = false;
      reportProgress();
    }, 150);
  }

  // External page change
  $effect(() => {
    if (currentPage !== lastReportedPage && scroller) {
      lastReportedPage = currentPage;
      navigateToPage(currentPage - 1);
    }
  });

  // ============================================================
  // Keyboard
  // ============================================================

  /**
   * Navigate to a page. If the target is past the boundaries,
   * exit to the series page instead.
   */
  function navigateToPage(pageIdx: number) {
    if (!scroller || !scrollContainer) return;

    // Past the end — mark complete and exit
    if (pageIdx >= pages.length) {
      const { charCount } = getCharCount(pages, pages.length);
      onPageChange(pages.length, charCount, true);
      onVolumeNav('next');
      return;
    }
    // Before the start — exit
    if (pageIdx < 0) {
      onVolumeNav('prev');
      return;
    }
    interruptZoomForNav();
    navTarget = pageIdx;
    navIsKeyboard = true;
    const el = pageElements[pageIdx];
    if (!el) return;

    // Cover page is always displayed alone
    const isCoverAlone = volumeSettings.hasCover && pageIdx === 0;

    // If a neighbor fits and it's not the cover page, center the pair
    if (!isCoverAlone) {
      const neighbor = pageIdx + 1 < pages.length ? pageIdx + 1 : pageIdx - 1;
      // Don't pair with the cover page either
      const neighborIsCover = volumeSettings.hasCover && neighbor === 0;
      const neighborEl = neighbor >= 0 && !neighborIsCover ? pageElements[neighbor] : null;

      if (neighborEl) {
        const elRect = el.getBoundingClientRect();
        const neighborRect = neighborEl.getBoundingClientRect();
        if (elRect.width + neighborRect.width <= scrollContainer.clientWidth + 2) {
          scroller.scrollToPairCenter(el, neighborEl);
          return;
        }
      }
    }

    scroller.scrollToElement(el, 'center', 'center');
  }

  function handleKeydown(e: KeyboardEvent) {
    if (keyboardShouldIgnore(e.target)) return;
    if (!scrollContainer) return;

    // Always use navTarget — it's authoritative.
    // Set by navigateToPage() on keyboard nav, synced by manual scroll.
    const current = navTarget;
    const leftDelta = rtl ? 1 : -1;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        navigateToPage(current + leftDelta);
        break;
      case 'ArrowRight':
        e.preventDefault();
        navigateToPage(current - leftDelta);
        break;
      case 'ArrowUp':
        e.preventDefault();
        interruptZoomForNav();
        scroller?.scrollBy(0, -viewportHeight * 0.5);
        break;
      case 'ArrowDown':
        e.preventDefault();
        interruptZoomForNav();
        scroller?.scrollBy(0, viewportHeight * 0.5);
        break;
      case 'PageDown':
      case ' ': {
        e.preventDefault();
        // Jump 1 from cover page, 2 otherwise
        const fwd = volumeSettings.hasCover && current === 0 ? 1 : 2;
        navigateToPage(current + fwd);
        break;
      }
      case 'PageUp': {
        e.preventDefault();
        // Jump 1 when landing on cover page, 2 otherwise
        const back = volumeSettings.hasCover && current <= 2 ? 1 : 2;
        navigateToPage(current - back);
        break;
      }
      case 'Home':
        e.preventDefault();
        navigateToPage(0);
        break;
      case 'End':
        e.preventDefault();
        navigateToPage(pages.length - 1);
        break;
    }
  }

  // ============================================================
  // Wheel — scroll along strip or zoom
  // ============================================================

  function handleWheel(e: WheelEvent) {
    if (!scrollContainer) return;
    const modifier = e.ctrlKey || e.metaKey;

    if (wheelIntentIsZoom(modifier, $settings.swapWheelBehavior)) {
      e.preventDefault();
      scroller?.stop();
      // A held-button drag would keep writing absolute positions from its
      // pre-zoom baseline, fighting the correction frames.
      isDragging = false;
      zoomController.wheelZoom(e);
      return;
    }

    // Scroll intent: convert vertical wheel to horizontal strip scroll.
    e.preventDefault();
    if (zoomController.isActive) zoomController.finishNow();
    const delta = normalizeWheelDelta(e.deltaY, e.deltaMode);
    scrollContainer.scrollLeft += rtl ? -delta : delta;
  }

  // ============================================================
  // Click-drag panning
  // ============================================================

  let isDragging = false;
  let wasDrag = false;
  let textBoxWasActive = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragScrollLeft = 0;
  let dragScrollTop = 0;
  const DRAG_THRESHOLD = 5;

  let activePointers = new Map<number, { x: number; y: number }>();

  function handlePointerDown(e: PointerEvent) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gestureTargetRole(e.target) === 'textbox') {
      textBoxWasActive = true;
      return;
    }

    if (activePointers.size >= 2) {
      // Pinch start — also re-baselines when the pointer set changes
      // (third finger down) so the gesture stays continuous.
      isDragging = false;
      wasDrag = true;
      scroller?.stop();
      zoomController.pinchStart([...activePointers.values()]);
      return;
    }

    if (e.button !== 0) return;

    if (zoomController.isActive) zoomController.finishNow();
    isDragging = true;
    wasDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragScrollLeft = scrollContainer?.scrollLeft ?? 0;
    dragScrollTop = scrollContainer?.scrollTop ?? 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (activePointers.size >= 2) {
      zoomController.pinchMove([...activePointers.values()]);
      return;
    }

    if (!isDragging || !scrollContainer) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (!wasDrag && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      wasDrag = true;
      window.getSelection()?.removeAllRanges();
    }

    if (wasDrag) {
      e.preventDefault();
      scrollContainer.scrollLeft = dragScrollLeft - dx;
      if (isZoomed || scrollContainer.scrollHeight > scrollContainer.clientHeight + 1) {
        scrollContainer.scrollTop = dragScrollTop - dy;
      }
    }
  }

  function handlePointerUp(e: PointerEvent) {
    const hadPointer = activePointers.has(e.pointerId);
    activePointers.delete(e.pointerId);

    if (hadPointer && activePointers.size >= 1 && zoomController.isActive) {
      if (activePointers.size >= 2) {
        // A pinch finger lifted but two remain — re-baseline on the new pair.
        zoomController.pinchStart([...activePointers.values()]);
      } else {
        zoomController.pinchEnd();
      }
      return;
    }
    if (activePointers.size === 0) zoomController.pinchEnd();

    if (isDragging) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    isDragging = false;
  }

  // ============================================================
  // Overlay toggle + double-tap zoom
  // ============================================================

  let lastTapTime = 0;
  const DOUBLE_TAP_DELAY = 300;

  function handleClick(e: MouseEvent) {
    if (gestureTargetRole(e.target) !== 'page') return;
    if (wasDrag) return;

    // First tap outside after interacting with a text box dismisses it without toggling
    if (textBoxWasActive) {
      textBoxWasActive = false;
      return;
    }

    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_DELAY) {
      lastTapTime = 0;
      scroller?.stop();
      zoomController.toggleZoom(e.clientX, e.clientY);
      return;
    }
    lastTapTime = now;
    const tapTime = now;
    setTimeout(() => {
      if (lastTapTime === tapTime) onOverlayToggle?.();
    }, DOUBLE_TAP_DELAY);
  }

  // ============================================================
  // Safari desktop trackpad pinch (proprietary gesture events)
  // ============================================================

  interface WebKitGestureEvent extends Event {
    scale: number;
    clientX: number;
    clientY: number;
  }

  function handleGestureStart(e: Event) {
    e.preventDefault();
    const ge = e as WebKitGestureEvent;
    scroller?.stop();
    zoomController.gestureStart(ge.clientX ?? viewportWidth / 2, ge.clientY ?? viewportHeight / 2);
  }

  function handleGestureChange(e: Event) {
    e.preventDefault();
    const ge = e as WebKitGestureEvent;
    zoomController.gestureChange(
      ge.scale ?? 1,
      ge.clientX ?? viewportWidth / 2,
      ge.clientY ?? viewportHeight / 2
    );
  }

  function handleGestureEnd(e: Event) {
    e.preventDefault();
    zoomController.gestureEnd();
  }

  // ============================================================
  // Resize
  // ============================================================

  function handleResize() {
    const wasLandscape = viewportWidth > viewportHeight;
    const pageIdx = lastReportedPage - 1;
    zoomController.reset();
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    const isLandscape = viewportWidth > viewportHeight;

    tick().then(() => {
      applyAlignment(1);
      if (isLandscape && !wasLandscape) {
        // Rotated to landscape — center pair if both fit
        navigateToPage(pageIdx);
      } else {
        // Rotated to portrait or just resized — use current page
        const el = pageElements[pageIdx];
        if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
      }
    });
  }

  onMount(() => {
    if (scrollContainer) {
      scroller = new ScrollAnimator(scrollContainer);
    }
    outerDiv?.addEventListener('wheel', handleWheel, { passive: false });
    outerDiv?.addEventListener('gesturestart', handleGestureStart);
    outerDiv?.addEventListener('gesturechange', handleGestureChange);
    outerDiv?.addEventListener('gestureend', handleGestureEnd);
    requestAnimationFrame(() => {
      applyAlignment(1);
      // Use navigateToPage for pair centering on landscape mount
      if (scroller) {
        navigateToPage(currentPage - 1);
      } else {
        const el = pageElements[currentPage - 1];
        if (el) el.scrollIntoView({ behavior: 'instant', inline: 'center' });
      }
    });
  });

  onDestroy(() => {
    scroller?.destroy();
    zoomController.destroy();
    outerDiv?.removeEventListener('wheel', handleWheel);
    outerDiv?.removeEventListener('gesturestart', handleGestureStart);
    outerDiv?.removeEventListener('gesturechange', handleGestureChange);
    outerDiv?.removeEventListener('gestureend', handleGestureEnd);
    if (settleTimer) clearTimeout(settleTimer);
  });
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<div
  bind:this={outerDiv}
  class="fixed inset-0"
  style:background-color="var(--reader-bg)"
  style:touch-action="none"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  onclick={handleClick}
  role="none"
>
  <div
    bind:this={scrollContainer}
    class="scrollbar-hide flex h-full"
    style:align-items="center"
    style:overflow-x="auto"
    style:overflow-y="auto"
    style:overscroll-behavior="none"
    style:overflow-anchor="none"
    style:direction={rtl ? 'rtl' : 'ltr'}
    onscroll={handleScroll}
  >
    <div
      bind:this={zoomSpacerEl}
      class="flex"
      style:align-items="center"
      style:direction={rtl ? 'rtl' : 'ltr'}
      style:filter={$imageFilter}
    >
      <!-- transform-origin is set by applyHorizontalZoomLayout (top right in RTL) -->
      <div
        bind:this={zoomWrapperEl}
        class="flex"
        style:align-items="center"
        style:direction={rtl ? 'rtl' : 'ltr'}
      >
        <!-- Centering spacer: allows first page to be centered -->
        <div class="flex-shrink-0" style:width="50vw"></div>
        {#each pages as page, i (i)}
          {@const size = pageSize(page)}
          {@const scale = size.height / page.img_height}
          {@const gap = $settings.pageDividers ? `${$settings.scrollGap - 1}px` : '-1px'}
          <div
            bind:this={pageElements[i]}
            class="relative flex-shrink-0 overflow-hidden"
            style:width={`${size.width}px`}
            style:height={`${size.height}px`}
            style:direction="ltr"
            style:margin-right={gap}
          >
            <div
              class="origin-top-left"
              style:transform={`scale(${scale})`}
              style:width={`${page.img_width}px`}
              style:height={`${page.img_height}px`}
            >
              <MangaPage
                {page}
                src={indexedFiles[i]}
                volumeUuid={volume.volume_uuid}
                pageIndex={i}
                forceVisible={missingPagePaths.has(page.img_path)}
                {onContextMenu}
              />
            </div>
          </div>
        {/each}
        <!-- Centering spacer: allows last page to be centered -->
        <div class="flex-shrink-0" style:width="50vw"></div>
      </div>
    </div>
  </div>
</div>

<style>
  .scrollbar-hide {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
</style>
