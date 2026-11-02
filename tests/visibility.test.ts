import { expect, it } from 'vitest';
import { BarVisibility, parseFullscreenSample } from '../src/main/visibility';

it('hides only on the bar monitor, restores without focus, and follows a monitor move', () => {
  const changes: boolean[] = []; const visibility = new BarVisibility(value => changes.push(value));
  visibility.setSample({ monitor: '1', fullscreenMonitors: ['2'] }); visibility.setReady();
  expect(changes).toEqual([true]);
  visibility.setSample({ monitor: '2', fullscreenMonitors: ['2'] });
  expect(changes).toEqual([true, false]);
  visibility.setSample({ monitor: '2', fullscreenMonitors: [] });
  expect(changes).toEqual([true, false, true]);
});
it('manual hiding survives fullscreen transitions and restore respects active fullscreen', () => {
  const changes: boolean[] = []; const visibility = new BarVisibility(value => changes.push(value));
  visibility.setReady(); visibility.hide();
  visibility.setSample({ monitor: '1', fullscreenMonitors: ['1'] });
  visibility.setSample({ monitor: '1', fullscreenMonitors: [] });
  expect(changes).toEqual([true, false]);
  visibility.setSample({ monitor: '1', fullscreenMonitors: ['1'] }); visibility.restore();
  expect(changes).toEqual([true, false]);
  visibility.setSample({ monitor: '1', fullscreenMonitors: [] });
  expect(changes).toEqual([true, false, true]);
});
it('does not flash on startup in fullscreen and recovers if detection fails', () => {
  const changes: boolean[] = []; const visibility = new BarVisibility(value => changes.push(value));
  visibility.setSample({ monitor: '1', fullscreenMonitors: ['1'] }); visibility.setReady();
  expect(changes).toEqual([]);
  visibility.unavailable(); expect(changes).toEqual([true]);
  visibility.hide(); visibility.unavailable(); expect(changes).toEqual([true, false]);
});
it('rejects malformed native messages', () => {
  expect(() => parseFullscreenSample({ monitor: 1, fullscreenMonitors: [] })).toThrow();
  expect(() => parseFullscreenSample({ monitor: '1', fullscreenMonitors: ['x'] })).toThrow();
  expect(parseFullscreenSample({ monitor: '1', fullscreenMonitors: ['2'] })).toEqual({ monitor: '1', fullscreenMonitors: ['2'] });
});
