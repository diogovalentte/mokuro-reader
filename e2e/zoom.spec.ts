import { test, expect, type Page } from '@playwright/test';

/**
 * E2E tests for the continuous-mode targeted zoom (#195).
 *
 * Unlike the previous version of this file — which re-implemented the old
 * absolute-scroll math inline — these tests import the REAL
 * ContinuousZoomController through the Vite dev server and drive it against
 * synthetic page strips that mirror the readers' layout (including the
 * fit-to-width page boxes, mx-auto centering, RTL direction, and the
 * transform-origin rules), asserting in a real browser that anchors stay
 * pinned and content stays reachable.
 */

type WorldOpts = { mode: 'vertical' | 'horizontal'; rtl?: boolean; pageWidth?: number };

async function setupWorld(page: Page, opts: WorldOpts) {
  await page.goto('/');
  // Let the app finish booting before we take over the document.
  await page.waitForTimeout(500);

  await page.evaluate(async ({ mode, rtl, pageWidth }) => {
    const w = window as any;
    document.body.innerHTML = '';
    Object.assign(document.body.style, { margin: '0', overflow: 'hidden', background: '#000' });

    const outer = document.createElement('div');
    Object.assign(outer.style, { position: 'fixed', inset: '0' });
    const scroll = document.createElement('div');
    const spacer = document.createElement('div');
    const wrapper = document.createElement('div');
    const pages: HTMLDivElement[] = [];

    if (mode === 'vertical') {
      Object.assign(scroll.style, {
        width: '100%',
        height: '100%',
        overflow: 'auto',
        overscrollBehavior: 'none',
        overflowAnchor: 'none'
      });
      const lead = document.createElement('div');
      lead.style.height = '50vh';
      const tail = document.createElement('div');
      tail.style.height = '50vh';
      wrapper.appendChild(lead);
      for (let i = 0; i < 10; i++) {
        const p = document.createElement('div');
        // Default: fit-to-width — the page layout box derives from the
        // wrapper width, the exact geometry that broke the old absolute-
        // scroll targeting. With pageWidth: fixed-size fit-to-screen-like
        // pages narrower than the viewport (side margins).
        Object.assign(
          p.style,
          pageWidth
            ? {
                width: `${pageWidth}px`,
                height: `${Math.round((pageWidth * 2000) / 1400)}px`,
                margin: '0 auto -1px',
                position: 'relative',
                overflow: 'hidden',
                background: `hsl(${i * 36}, 70%, 40%)`
              }
            : {
                width: '100%',
                aspectRatio: '1400 / 2000',
                margin: '0 auto -1px',
                position: 'relative',
                overflow: 'hidden',
                background: `hsl(${i * 36}, 70%, 40%)`
              }
        );
        wrapper.appendChild(p);
        pages.push(p);
      }
      wrapper.appendChild(tail);
    } else {
      const dir = rtl ? 'rtl' : 'ltr';
      Object.assign(scroll.style, {
        display: 'flex',
        height: '100%',
        alignItems: 'center',
        overflow: 'auto',
        overscrollBehavior: 'none',
        overflowAnchor: 'none',
        direction: dir
      });
      Object.assign(spacer.style, { display: 'flex', alignItems: 'center', direction: dir });
      Object.assign(wrapper.style, {
        display: 'flex',
        alignItems: 'center',
        direction: dir
      });
      const lead = document.createElement('div');
      Object.assign(lead.style, { flexShrink: '0', width: '50vw' });
      const tail = document.createElement('div');
      Object.assign(tail.style, { flexShrink: '0', width: '50vw' });
      wrapper.appendChild(lead);
      const pageWidth = Math.round((1400 / 2000) * innerHeight); // fit-to-height
      for (let i = 0; i < 10; i++) {
        const p = document.createElement('div');
        Object.assign(p.style, {
          width: `${pageWidth}px`,
          height: `${innerHeight}px`,
          flexShrink: '0',
          position: 'relative',
          overflow: 'hidden',
          marginRight: '-1px',
          direction: 'ltr',
          background: `hsl(${i * 36}, 70%, 40%)`
        });
        wrapper.appendChild(p);
        pages.push(p);
      }
      wrapper.appendChild(tail);
    }

    spacer.appendChild(wrapper);
    scroll.appendChild(spacer);
    outer.appendChild(scroll);
    document.body.appendChild(outer);

    // Drive the REAL production layout appliers (incl. the wrapper width pin
    // and the RTL transform-origin rule) — not inline mirrors that would
    // silently keep passing if the production rules regressed.
    const layout = await import('/src/lib/reader/zoom-layout.ts');
    const applyZoomLayout =
      mode === 'vertical'
        ? (zoom: number) =>
            layout.applyVerticalZoomLayout(
              { wrapper, spacer },
              { width: innerWidth, height: innerHeight },
              pageWidth ?? innerWidth,
              zoom
            )
        : (zoom: number) =>
            layout.applyHorizontalZoomLayout({ wrapper, spacer, container: scroll }, !!rtl, zoom);

    const mod = await import('/src/lib/reader/zoom-controller.ts');
    const controller = new mod.ContinuousZoomController({
      getScrollContainer: () => scroll,
      getPageElements: () => pages,
      getViewport: () => ({ width: innerWidth, height: innerHeight }),
      applyZoomLayout
    });

    w.__zoom = {
      controller,
      scroll,
      spacer,
      wrapper,
      pages,
      settle: () =>
        new Promise<void>((resolve, reject) => {
          const t0 = performance.now();
          const check = () => {
            if (!controller.isActive) return resolve();
            if (performance.now() - t0 > 10000) return reject(new Error('zoom never settled'));
            requestAnimationFrame(check);
          };
          check();
        }),
      frac(i: number, x: number, y: number) {
        const r = pages[i].getBoundingClientRect();
        return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
      },
      pos(i: number, fx: number, fy: number) {
        const r = pages[i].getBoundingClientRect();
        return { x: r.left + fx * r.width, y: r.top + fy * r.height };
      }
    };
  }, opts);
}

test('vertical fit-to-width: double-tap centers the tapped content on a middle page', async ({
  page
}) => {
  await setupWorld(page, { mode: 'vertical' });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[5].scrollIntoView({ block: 'center' });
    const tap = { x: innerWidth / 2 + 300, y: innerHeight / 2 };
    const frac = z.frac(5, tap.x, tap.y);
    z.controller.toggleZoom(tap.x, tap.y);
    await z.settle();
    return {
      zoom: z.controller.currentZoom,
      pos: z.pos(5, frac.fx, frac.fy),
      vw: innerWidth,
      vh: innerHeight
    };
  });
  expect(r.zoom).toBe(2);
  expect(Math.abs(r.pos.x - r.vw / 2)).toBeLessThan(2);
  expect(Math.abs(r.pos.y - r.vh / 2)).toBeLessThan(2);
});

test('vertical fit-to-width: wheel zoom pins the cursor point and page boxes stay zoom-invariant', async ({
  page
}) => {
  await setupWorld(page, { mode: 'vertical' });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[3].scrollIntoView({ block: 'center' });
    const cursor = { x: 700, y: 600 };
    const frac = z.frac(3, cursor.x, cursor.y);

    z.controller.wheelZoom({
      deltaY: -120,
      deltaMode: 0,
      clientX: cursor.x,
      clientY: cursor.y,
      timeStamp: performance.now()
    });
    await z.settle();
    const pos1 = z.pos(3, frac.fx, frac.fy);
    const zoom1 = z.controller.currentZoom;

    z.controller.wheelZoom({
      deltaY: -120,
      deltaMode: 0,
      clientX: cursor.x,
      clientY: cursor.y,
      timeStamp: performance.now()
    });
    await z.settle();
    const pos2 = z.pos(3, frac.fx, frac.fy);
    const zoom2 = z.controller.currentZoom;

    // Page layout boxes must scale once (transform), not twice (layout × transform)
    const pageRectWidth = z.pages[3].getBoundingClientRect().width;

    // Page detection (issue #195's "aberrant paging"): with page 6's center
    // scrolled to the viewport center at 2×, the real detection module must
    // report 6 — the old offsetTop-based detection drifted by the zoom factor.
    const det = await import('/src/lib/reader/page-detection.ts');
    const r6 = z.pages[6].getBoundingClientRect();
    z.scroll.scrollTop += r6.top + r6.height / 2 - innerHeight / 2;
    const detected = det.closestPageToCenter(
      z.scroll.getBoundingClientRect(),
      z.pages.map((p: Element) => p.getBoundingClientRect()),
      'y'
    );

    return { cursor, pos1, zoom1, pos2, zoom2, pageRectWidth, detected, vw: innerWidth };
  });
  expect(r.zoom1).toBe(1.5);
  expect(r.zoom2).toBe(2);
  expect(Math.abs(r.pos1.x - r.cursor.x)).toBeLessThan(2);
  expect(Math.abs(r.pos1.y - r.cursor.y)).toBeLessThan(2);
  expect(Math.abs(r.pos2.x - r.cursor.x)).toBeLessThan(2);
  expect(Math.abs(r.pos2.y - r.cursor.y)).toBeLessThan(2);
  expect(Math.abs(r.pageRectWidth - r.vw * 2)).toBeLessThan(2);
  expect(r.detected).toBe(6);
});

test('vertical: pinching inward at min zoom leaves the position untouched', async ({ page }) => {
  await setupWorld(page, { mode: 'vertical' });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[2].scrollIntoView({ block: 'center' });
    const before = { left: z.scroll.scrollLeft, top: z.scroll.scrollTop };
    z.controller.pinchStart([
      { x: 860, y: 540 },
      { x: 1060, y: 540 }
    ]);
    z.controller.pinchMove([
      { x: 910, y: 540 },
      { x: 1010, y: 540 }
    ]);
    z.controller.pinchEnd();
    await z.settle();
    return {
      before,
      after: { left: z.scroll.scrollLeft, top: z.scroll.scrollTop },
      zoom: z.controller.currentZoom
    };
  });
  expect(r.zoom).toBe(1);
  expect(r.after.left).toBe(r.before.left);
  expect(r.after.top).toBe(r.before.top);
});

test('horizontal RTL: zoom pins the anchor and the volume start stays reachable', async ({
  page
}) => {
  await setupWorld(page, { mode: 'horizontal', rtl: true });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[0].scrollIntoView({ inline: 'center' });
    const rect = z.pages[0].getBoundingClientRect();
    const anchor = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const frac = z.frac(0, anchor.x, anchor.y);

    z.controller.cycleZoom(1, anchor.x, anchor.y);
    await z.settle();
    z.controller.cycleZoom(1, anchor.x, anchor.y);
    await z.settle();
    const pos = z.pos(0, frac.fx, frac.fy);

    // Reachability: at the RTL scroll origin (scrollLeft = 0, its maximum)
    // the strip's right edge must sit at the viewport edge — with the old
    // top-left transform-origin the scaled strip extended unreachably past it.
    z.scroll.scrollLeft = 1e9; // clamps to 0 in RTL
    const wrapRight = z.wrapper.getBoundingClientRect().right;

    return { anchor, pos, zoom: z.controller.currentZoom, wrapRight, vw: innerWidth };
  });
  expect(r.zoom).toBe(2);
  expect(Math.abs(r.pos.x - r.anchor.x)).toBeLessThan(2);
  expect(Math.abs(r.pos.y - r.anchor.y)).toBeLessThan(2);
  expect(r.wrapRight).toBeLessThanOrEqual(r.vw + 1);
  expect(r.wrapRight).toBeGreaterThan(r.vw - 2);
});

test('horizontal LTR: double-tap zooms in and a second double-tap restores 1×', async ({
  page
}) => {
  await setupWorld(page, { mode: 'horizontal', rtl: false });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[2].scrollIntoView({ inline: 'center' });
    const rect = z.pages[2].getBoundingClientRect();
    const tap = { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.25 };
    const frac = z.frac(2, tap.x, tap.y);

    z.controller.toggleZoom(tap.x, tap.y);
    await z.settle();
    const zoomedPos = z.pos(2, frac.fx, frac.fy);
    const zoomedZoom = z.controller.currentZoom;

    z.controller.toggleZoom(innerWidth / 2, innerHeight / 2);
    await z.settle();

    return {
      zoomedZoom,
      zoomedPos,
      finalZoom: z.controller.currentZoom,
      transform: z.wrapper.style.transform,
      spacerWidth: z.spacer.style.width,
      vw: innerWidth,
      vh: innerHeight
    };
  });
  expect(r.zoomedZoom).toBe(2);
  expect(Math.abs(r.zoomedPos.x - r.vw / 2)).toBeLessThan(2);
  expect(Math.abs(r.zoomedPos.y - r.vh / 2)).toBeLessThan(2);
  expect(r.finalZoom).toBe(1);
  expect(r.transform).toBe('');
  expect(r.spacerWidth).toBe('');
});

test('vertical fit-to-screen: side margins are not pannable while zoomed', async ({ page }) => {
  // Narrow fixed-size pages (560px in a 1920px viewport): at 2x the scaled
  // content (1120px) still fits, so there must be NO horizontal scroll range
  // — previously the spacer spanned viewport×zoom and the page could be
  // panned fully off screen through its own empty margins.
  await setupWorld(page, { mode: 'vertical', pageWidth: 560 });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[2].scrollIntoView({ block: 'center' });
    z.controller.cycleZoom(1, innerWidth / 2, innerHeight / 2);
    await z.settle();
    z.controller.cycleZoom(1, innerWidth / 2, innerHeight / 2);
    await z.settle();

    z.scroll.scrollLeft = 99999; // try to pan the page away
    const afterRight = z.pages[2].getBoundingClientRect();
    z.scroll.scrollLeft = -99999;
    const afterLeft = z.pages[2].getBoundingClientRect();

    return {
      zoom: z.controller.currentZoom,
      scrollWidth: z.scroll.scrollWidth,
      clientWidth: z.scroll.clientWidth,
      centeredLeft: afterRight.left,
      expectedLeft: (innerWidth - afterRight.width) / 2,
      sameAfterPanAttempts: Math.abs(afterRight.left - afterLeft.left) < 1
    };
  });
  expect(r.zoom).toBe(2);
  expect(r.scrollWidth).toBeLessThanOrEqual(r.clientWidth + 1); // no margin pan range
  expect(r.sameAfterPanAttempts).toBe(true);
  expect(Math.abs(r.centeredLeft - r.expectedLeft)).toBeLessThan(2); // stays centered
});

test('vertical fit-to-screen: overflow pan range hugs the content edges exactly', async ({
  page
}) => {
  // 700px pages at 3x = 2100px > 1920px viewport: a 180px range must exist,
  // with the content edges flush to the viewport at both extremes.
  await setupWorld(page, { mode: 'vertical', pageWidth: 700 });
  const r = await page.evaluate(async () => {
    const z = (window as any).__zoom;
    z.pages[2].scrollIntoView({ block: 'center' });
    for (let i = 0; i < 3; i++) {
      z.controller.cycleZoom(1, innerWidth / 2, innerHeight / 2);
      await z.settle();
    }
    z.scroll.scrollLeft = 0;
    const atStart = z.pages[2].getBoundingClientRect();
    z.scroll.scrollLeft = 99999;
    const atEnd = z.pages[2].getBoundingClientRect();
    return {
      zoom: z.controller.currentZoom,
      range: z.scroll.scrollWidth - z.scroll.clientWidth,
      startLeft: atStart.left,
      endRight: atEnd.left + atEnd.width,
      vw: innerWidth
    };
  });
  expect(r.zoom).toBe(3);
  expect(Math.abs(r.range - (700 * 3 - r.vw))).toBeLessThan(2);
  expect(Math.abs(r.startLeft - 0)).toBeLessThan(2); // left edge flush at start
  expect(Math.abs(r.endRight - r.vw)).toBeLessThan(2); // right edge flush at end
});
