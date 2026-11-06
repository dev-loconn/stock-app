export interface Bounds { x: number; y: number; width: number; height: number }

export function panelMetrics(fontSize: number) {
  return { header: fontSize + 24, row: fontSize * 2 + 20, empty: 96 };
}

/** All coordinates are Electron DIPs, including negative monitor origins. */
export function panelBounds(bar: Bounds, work: Bounds, rows: number, fontSize: number): Bounds {
  const metrics = panelMetrics(fontSize);
  const width = Math.min(work.width, Math.max(1, bar.width));
  const wanted = metrics.header + (rows ? Math.min(6, rows) * metrics.row : metrics.empty) + 2;
  const below = Math.max(0, work.y + work.height - (bar.y + bar.height));
  const above = Math.max(0, bar.y - work.y);
  const down = below >= wanted || below >= above;
  const height = Math.max(1, Math.min(wanted, down ? below : above, work.height));
  const x = Math.max(work.x, Math.min(bar.x, work.x + work.width - width));
  const y = Math.max(work.y, Math.min(down ? bar.y + bar.height : bar.y - height, work.y + work.height - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
