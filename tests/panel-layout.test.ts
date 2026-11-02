import { expect, it } from 'vitest';
import { panelBounds } from '../src/shared/panel-layout';

it('anchors below, flips above, and clamps at the edges without moving the bar', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  expect(panelBounds({ x: 100, y: 20, width: 600, height: 44 }, work, 10, 14)).toEqual({ x: 100, y: 64, width: 600, height: 328 });
  expect(panelBounds({ x: 1800, y: 990, width: 200, height: 44 }, work, 10, 14)).toEqual({ x: 1600, y: 662, width: 320, height: 328 });
  expect(panelBounds({ x: -20, y: 20, width: 200, height: 44 }, work, 1, 14).x).toBe(0);
});

it('fits negative-origin monitors, small work areas and large fonts; all securities stay scrollable', () => {
  for (const work of [
    { x: -1600, y: -300, width: 1600, height: 900 },
    { x: 0, y: 0, width: 250, height: 180 },
    { x: 100, y: 100, width: 100, height: 60 },
  ]) for (const rows of [0, 1, 6, 10]) for (const font of [12, 14, 20]) {
    const bar = { x: work.x + 10, y: work.y + Math.floor(work.height / 2), width: 600, height: 44 };
    const bounds = panelBounds(bar, work, rows, font);
    expect(bounds.x).toBeGreaterThanOrEqual(work.x);
    expect(bounds.y).toBeGreaterThanOrEqual(work.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(work.x + work.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(work.y + work.height);
    expect(bounds.height).toBeGreaterThan(0);
  }
  const bar = { x: 0, y: 0, width: 320, height: 44 };
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  expect(panelBounds(bar, work, 6, 14).height).toBe(panelBounds(bar, work, 10, 14).height);
  expect(panelBounds(bar, work, 1, 14).height).toBeLessThan(panelBounds(bar, work, 6, 14).height);
});
