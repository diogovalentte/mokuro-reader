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
  import { applyVerticalZoomLayout } from '$lib/reader/zoom-layout';
  import { closestPageToCenter } from '$lib/reader/page-detection';
  import { normalizeWheelDelta, wheelIntentIsZoom } from '$lib/reader/zoom-math';
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
    onContextMenu
  }: Props = $props();

  let outerDiv: HTMLDivElement | undefined = $state();
  let scrollContainer: HTMLDivElement | undefined = $state();
  let scroller: ScrollAnimator | null = null;
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);
  let indexedFiles = $derived.by(() => matchFilesToPages(files, pages));
  let missingPagePaths = $derived(new Set(volume?.missing_page_paths || []));
  let zoomMode = $derived($settings.continuousZoomDefault);

  // Base scale for each page based on zoom mode
  function pageStyle(page: Page): { width: string; maxWidth: string; height: string } {
    if (zoomMode === 'zoomOriginal') {
      return {
        width: `${page.img_width}px`,
        maxWidth: `${page.img_width}px`,
        height: `${page.img_height}px`
      };
    }
    if (zoomMode === 'zoomFitToScreen') {
      // Scale so the entire page fits in the viewport
      const scaleW = viewportWidth / page.img_width;
      const scaleH = viewportHeight / page.img_height;
      const scale = Math.min(scaleW, scaleH);
      return {
        width: `${page.img_width * scale}px`,
        maxWidth: `${page.img_width * scale}px`,
        height: `${page.img_height * scale}px`
      };
    }
    // zoomFitToWidth (default) — always fill viewport width, upscale if needed
    return {
      width: '100%',
      maxWidth: '',
      height: 'auto'
    };
  }

  // ============================================================
  // Zoom — transform scale + measurement-based scroll correction
  // ============================================================

  let zoomWrapperEl: HTMLDivElement | undefined = $state();
  let zoomSpacerEl: HTMLDivElement | undefined = $state();
  let isZoomed = $state(false);

  /**
   * Widest page's scaled layout width at the current zoom mode — the zoomed
   * wrapper pins to this (not the viewport width) so empty side margins
   * never become pannable scroll range.
   */
  function maxContentWidth(): number {
    let max = 0;
    for (const page of pages) {
      let width: number;
      if (zoomMode === 'zoomOriginal') {
        width = page.img_width;
      } else if (zoomMode === 'zoomFitToScreen') {
        const scale = Math.min(viewportWidth / page.img_width, viewportHeight / page.img_height);
        width = page.img_width * scale;
      } else {
        width = viewportWidth; // zoomFitToWidth
      }
      if (width > max) max = width;
    }
    return max || viewportWidth;
  }

  // Reader-specific zoomed layout — shared with the e2e suite, see zoom-layout.ts
  function applyZoomLayout(zoom: number) {
    if (!zoomWrapperEl || !zoomSpacerEl) return;
    applyVerticalZoomLayout(
      { wrapper: zoomWrapperEl, spacer: zoomSpacerEl },
      { width: viewportWidth, height: viewportHeight },
      maxContentWidth(),
      zoom
    );
  }

  function handleZoomSettled(zoom: number, reason: SettleReason) {
    if (zoom <= 1 && scrollContainer) {
      // Reset the cross axis only when no scroll range legitimately remains
      // at 1× (zoomOriginal pages wider than the viewport keep theirs).
      if (scrollContainer.scrollWidth <= scrollContainer.clientWidth + 1) {
        scrollContainer.scrollLeft = 0;
      }
    }
    // 'nav' settles are superseded by the navigation that caused them, and
    // 'reset' settles have stale scroll geometry the caller re-anchors next.
    if (reason === 'gesture' || reason === 'interrupt') reportProgress();
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
  }

  // When the zoom mode (Z key) or a layout-affecting setting changes, reset
  // any user zoom (its measured spacer/transform are stale against the new
  // layout) and stay on the current page. Use lastReportedPage (set by
  // scroll progress tracking) since detectCurrentPage() would see the
  // already-shifted layout.
  let prevLayoutKey = `${$settings.continuousZoomDefault}|${$settings.pageDividers}|${$settings.scrollGap}`;
  $effect(() => {
    const layoutKey = `${zoomMode}|${$settings.pageDividers}|${$settings.scrollGap}`;
    if (layoutKey === prevLayoutKey) return;
    prevLayoutKey = layoutKey;

    const pageIdx = lastReportedPage - 1;
    zoomController.reset();
    tick().then(() => {
      const el = pageElements[pageIdx];
      if (el)
        el.scrollIntoView({
          behavior: 'instant',
          block: pageFitsVertically(pageIdx) ? 'center' : 'start'
        });
    });
  });

  // ============================================================
  // Progress tracking
  // ============================================================

  let lastReportedPage = currentPage;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let pageElements: HTMLDivElement[] = [];

  /**
   * Current page = element whose visual center is closest to the viewport
   * center. Uses getBoundingClientRect (visual space) so it stays correct
   * under the zoom transform — offsetTop is unscaled layout space and
   * diverges from scroll coordinates as soon as zoom != 1.
   */
  function detectCurrentPage(): number {
    if (!scrollContainer) return 0;
    return closestPageToCenter(
      scrollContainer.getBoundingClientRect(),
      pageElements.map((el) => el?.getBoundingClientRect()),
      'y'
    );
  }

  function reportProgress() {
    const pageIdx = detectCurrentPage();
    const pageNum = pageIdx + 1;
    if (pageNum !== lastReportedPage) {
      lastReportedPage = pageNum;
      const { charCount } = getCharCount(pages, pageNum);
      onPageChange(pageNum, charCount, pageNum >= pages.length);
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
      reportProgress();
    }, 150);
  }

  // External page change
  $effect(() => {
    if (currentPage !== lastReportedPage && scrollContainer) {
      lastReportedPage = currentPage;
      scrollToPageVertical(currentPage - 1);
    }
  });

  // ============================================================
  // Keyboard
  // ============================================================

  /**
   * Check if a page fits vertically in the viewport at the current zoom.
   * Visual rect height is transform-aware for any zoom value.
   */
  function pageFitsVertically(pageIdx: number): boolean {
    const el = pageElements[pageIdx];
    if (!el) return false;
    return el.getBoundingClientRect().height <= viewportHeight * 1.05;
  }

  function scrollToPageVertical(pageIdx: number) {
    if (!scroller) return;

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
    const el = pageElements[pageIdx];
    if (!el) return;

    scroller.scrollToElement(el, 'center', pageFitsVertically(pageIdx) ? 'center' : 'start');
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    )
      return;
    if (!scrollContainer) return;

    // In fit-to-screen, pages fit viewport — arrows page.
    // In fit-to-width/original, pages can be taller — arrows pan.
    const shouldPanVertically = zoomMode !== 'zoomFitToScreen';

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (shouldPanVertically) {
          interruptZoomForNav();
          scroller?.scrollBy(0, viewportHeight * 0.5);
        } else {
          scrollToPageVertical(detectCurrentPage() + 1);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shouldPanVertically) {
          interruptZoomForNav();
          scroller?.scrollBy(0, -viewportHeight * 0.5);
        } else {
          scrollToPageVertical(detectCurrentPage() - 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        interruptZoomForNav();
        scroller?.scrollBy(-viewportWidth * 0.5, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
        interruptZoomForNav();
        scroller?.scrollBy(viewportWidth * 0.5, 0);
        break;
      case 'PageDown':
      case ' ':
        e.preventDefault();
        scrollToPageVertical(detectCurrentPage() + 1);
        break;
      case 'PageUp':
        e.preventDefault();
        scrollToPageVertical(detectCurrentPage() - 1);
        break;
      case 'Home':
        e.preventDefault();
        scrollToPageVertical(0);
        break;
      case 'End':
        e.preventDefault();
        scrollToPageVertical(pages.length - 1);
        break;
    }
  }

  // ============================================================
  // Wheel — scroll or zoom
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

    if (modifier) {
      // Swap mode: modifier+wheel is the scroll intent. Scroll manually —
      // letting it fall through would trigger browser page zoom instead.
      e.preventDefault();
      if (zoomController.isActive) zoomController.finishNow();
      scrollContainer.scrollTop += normalizeWheelDelta(e.deltaY, e.deltaMode);
      return;
    }

    // Bare wheel scrolls natively; don't let it fight an active zoom.
    if (zoomController.isActive) zoomController.finishNow();
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

    if ((e.target as HTMLElement).closest('.textBox')) {
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
      scrollContainer.scrollTop = dragScrollTop - dy;
      if (isZoomed || scrollContainer.scrollWidth > scrollContainer.clientWidth + 1) {
        scrollContainer.scrollLeft = dragScrollLeft - dx;
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
    if ((e.target as HTMLElement).closest('.textBox, button, [role="button"], a')) return;
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
    const pageIdx = lastReportedPage - 1;
    zoomController.reset();
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    tick().then(() => {
      const el = pageElements[pageIdx];
      if (el)
        el.scrollIntoView({
          behavior: 'instant',
          block: pageFitsVertically(pageIdx) ? 'center' : 'start'
        });
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
      const el = pageElements[currentPage - 1];
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
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
    class="scrollbar-hide h-full w-full"
    style:overflow-y="auto"
    style:overflow-x="auto"
    style:overscroll-behavior="none"
    style:overflow-anchor="none"
    onscroll={handleScroll}
  >
    <div bind:this={zoomSpacerEl} style:filter={$imageFilter}>
      <!-- transform-origin is set by applyVerticalZoomLayout -->
      <div bind:this={zoomWrapperEl}>
        <!-- Centering spacer -->
        <div style:height="50vh"></div>
        {#each pages as page, i (i)}
          {@const ps = pageStyle(page)}
          {@const displayWidth = ps.height === 'auto' ? viewportWidth : parseFloat(ps.width)}
          {@const scale = displayWidth / page.img_width}
          <div
            bind:this={pageElements[i]}
            class="relative mx-auto overflow-hidden"
            style:width={ps.width}
            style:max-width={ps.maxWidth}
            style:aspect-ratio={ps.height === 'auto'
              ? `${page.img_width} / ${page.img_height}`
              : undefined}
            style:height={ps.height !== 'auto' ? ps.height : undefined}
            style:margin-bottom={$settings.pageDividers ? `${$settings.scrollGap - 1}px` : '-1px'}
          >
            <div
              class="origin-top-left"
              style:transform={scale !== 1 ? `scale(${scale})` : undefined}
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
        <!-- Centering spacer -->
        <div style:height="50vh"></div>
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
