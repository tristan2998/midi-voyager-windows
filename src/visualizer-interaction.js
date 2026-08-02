import { clamp } from './constants.js';

export function normalizedWheelPixels(deltaX, deltaY, deltaMode = 0, pageSize = 800) {
  const horizontal = Number(deltaX) || 0;
  const vertical = Number(deltaY) || 0;
  const dominant = Math.abs(vertical) >= Math.abs(horizontal) ? vertical : horizontal;
  const modeScale = deltaMode === 1 ? 16 : (deltaMode === 2 ? Math.max(1, Number(pageSize) || 800) : 1);
  return clamp(dominant * modeScale, -720, 720);
}

export function visualizerWindowSeconds(view, zoom = 1) {
  const safeZoom = clamp(Number(zoom) || 1, 0.25, 6);
  const scale = Math.sqrt(safeZoom);
  if (view === 'waterfall') return 0.65 + 8 / scale;
  if (view === 'roll') return 11.5 / scale;
  if (view === 'staff') return 10 / scale;
  return 10 / scale;
}

export function visualizerScrollSeconds(deltaX, deltaY, deltaMode, zoom, view, pageSize = 800) {
  const pixels = normalizedWheelPixels(deltaX, deltaY, deltaMode, pageSize);
  return pixels / 480 * visualizerWindowSeconds(view, zoom);
}

export function visualizerZoomMultiplier(deltaX, deltaY, deltaMode, pageSize = 800) {
  const pixels = normalizedWheelPixels(deltaX, deltaY, deltaMode, pageSize);
  return Math.exp(-clamp(pixels, -240, 240) / 500);
}
