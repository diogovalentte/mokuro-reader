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

type WorldOpts = { mode: 'vertical' | 'horizontal'; rtl?: boolean };

async function setupWorld(page: Page, opts: WorldOpts) {
  await page.goto('/');
  // Let the app finish booting before we take over the document.
  await page.waitForTimeout(500);

  await page.evaluate(async ({ mode, rtl }) => {
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
      wrapper.style.transformOrigin = 'top left';
      const lead = document.createElement('div');
      lead.style.height = '50vh';
      const tail = document.createElement('div');
      tail.style.height = '50vh';
      wrapper.appendChild(lead);
      for (let i = 0; i < 10; i++) {
        const p = document.createElement('div');
        // fit-to-width: the page layout box derives from the wrapper width —
        // the exact geometry that broke the old absolute-scroll targeting.
        Object.assign(p.style, {
          width: '100%',
          aspectRatio: '1400 / 2000',
          margin: '0 auto -1px',
          position: 'relative',
          overflow: 'hidden',
          background: `hsl(${i * 36}, 70%, 40%)`
        });
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
        direction: dir,
        transformOrigin: rtl ? 'top right' : 'top left'
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

    // Layout appliers mirroring the readers' applyZoomLayout
    function applyVertical(zoom: number) {
      if (zoom > 1) {
        wrapper.style.width = `${innerWidth}px`;
        spacer.style.width = `${innerWidth * zoom}px`;
        spacer.style.minHeight = `${wrapper.offsetHeight * zoom + innerHeight}px`;
        wrapper.style.transform = `scale(${zoom})`;
      } else {
        wrapper.style.transform = '';
        wrapper.style.width = '';
        spacer.style.width = '';
        spacer.style.minHeight = '';
      }
    }

    function applyHorizontal(zoom: number) {
      if (zoom > 1) {
        spacer.style.width = `${wrapper.offsetWidth * zoom}px`;
        spacer.style.height = `${wrapper.offsetHeight * zoom}px`;
        wrapper.style.transform = `scale(${zoom})`;
      } else {
        wrapper.style.transform = '';
        spacer.style.width = '';
        spacer.style.height = '';
      }
      const visualHeight = wrapper.offsetHeight * zoom;
      const align = visualHeight > scroll.clientHeight + 1 ? 'flex-start' : 'center';
      scroll.style.alignItems = align;
      spacer.style.alignItems = align;
    }

    const mod = await import('/src/lib/reader/zoom-controller.ts');
    const controller = new mod.ContinuousZoomController({
      getScrollContainer: () => scroll,
      getPageElements: () => pages,
      getViewport: () => ({ width: innerWidth, height: innerHeight }),
      applyZoomLayout: mode === 'vertical' ? applyVertical : applyHorizontal
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
    return { cursor, pos1, zoom1, pos2, zoom2, pageRectWidth, vw: innerWidth };
  });
  expect(r.zoom1).toBe(1.5);
  expect(r.zoom2).toBe(2);
  expect(Math.abs(r.pos1.x - r.cursor.x)).toBeLessThan(2);
  expect(Math.abs(r.pos1.y - r.cursor.y)).toBeLessThan(2);
  expect(Math.abs(r.pos2.x - r.cursor.x)).toBeLessThan(2);
  expect(Math.abs(r.pos2.y - r.cursor.y)).toBeLessThan(2);
  expect(Math.abs(r.pageRectWidth - r.vw * 2)).toBeLessThan(2);
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
