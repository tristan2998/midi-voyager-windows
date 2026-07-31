const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const WHITE_KEY_OFFSETS = [0, null, 1, null, 2, 3, null, 4, null, 5, null, 6];
const BLACK_KEY_BOUNDARIES = [null, 1, null, 2, null, null, 4, null, 5, null, 6, null];

export const PIANO_AREA_HEIGHT = 116;
export const BLACK_KEY_WIDTH_RATIO = 0.62;
export const BLACK_KEY_HEIGHT_RATIO = 0.62;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pitchClass(pitch) {
  return ((pitch % 12) + 12) % 12;
}

export function isBlackPianoKey(pitch) {
  return BLACK_PITCH_CLASSES.has(pitchClass(Math.round(pitch)));
}

function keyUnits(pitch) {
  const octave = Math.floor(pitch / 12);
  const note = pitchClass(pitch);
  if (isBlackPianoKey(pitch)) {
    const center = octave * 7 + BLACK_KEY_BOUNDARIES[note];
    return {
      start: center - BLACK_KEY_WIDTH_RATIO / 2,
      end: center + BLACK_KEY_WIDTH_RATIO / 2,
      center,
      black: true
    };
  }
  const start = octave * 7 + WHITE_KEY_OFFSETS[note];
  return { start, end: start + 1, center: start + 0.5, black: false };
}

export function visiblePianoRange(noteRange, zoom = 1) {
  const noteMin = Number.isFinite(noteRange?.min) ? clampNumber(Math.floor(noteRange.min), 0, 127) : 60;
  const noteMax = Number.isFinite(noteRange?.max) ? clampNumber(Math.ceil(noteRange.max), 0, 127) : 72;
  const sourceMin = Math.min(60, noteMin);
  const sourceMax = Math.max(72, noteMax);
  const safeZoom = clampNumber(Number(zoom) || 1, 0.25, 6);
  const count = clampNumber(Math.ceil((sourceMax - sourceMin + 12) / safeZoom), 18, 88);
  const center = clampNumber((sourceMin + sourceMax) / 2, 36, 84);
  let min = Math.floor(center - (count - 1) / 2);
  let max = min + count - 1;
  if (min < 0) { max -= min; min = 0; }
  if (max > 127) { min -= max - 127; max = 127; }
  return { min, max, count: max - min + 1 };
}

export function createPianoLayout(minPitch, maxPitch, width) {
  let min = clampNumber(Math.floor(Number(minPitch) || 0), 0, 127);
  let max = clampNumber(Math.ceil(Number(maxPitch) || 0), 0, 127);
  if (min > max) [min, max] = [max, min];

  // A black key needs both neighbouring white keys to look and behave correctly.
  if (isBlackPianoKey(min) && min > 0) min -= 1;
  if (isBlackPianoKey(max) && max < 127) max += 1;

  const first = keyUnits(min);
  const last = keyUnits(max);
  const left = first.start;
  const unitSpan = Math.max(1, last.end - left);
  const layoutWidth = Math.max(1, Number(width) || 1);
  const whiteKeyWidth = layoutWidth / unitSpan;
  const keys = [];
  const byPitch = new Map();

  for (let pitch = min; pitch <= max; pitch += 1) {
    const units = keyUnits(pitch);
    const key = {
      pitch,
      black: units.black,
      x: (units.start - left) * whiteKeyWidth,
      width: (units.end - units.start) * whiteKeyWidth,
      center: (units.center - left) * whiteKeyWidth
    };
    keys.push(key);
    byPitch.set(pitch, key);
  }

  return {
    min,
    max,
    width: layoutWidth,
    whiteKeyWidth,
    keys,
    whiteKeys: keys.filter((key) => !key.black),
    blackKeys: keys.filter((key) => key.black),
    byPitch
  };
}

export function pianoPitchAt(layout, x, y, height) {
  if (!layout || x < 0 || y < 0 || x > layout.width || y > height) return null;
  if (y <= height * BLACK_KEY_HEIGHT_RATIO) {
    const black = layout.blackKeys.find((key) => x >= key.x && x < key.x + key.width);
    if (black) return black.pitch;
  }
  const white = layout.whiteKeys.find((key, index) =>
    x >= key.x && (
      x < key.x + key.width ||
      (x === layout.width && index === layout.whiteKeys.length - 1)
    )
  );
  return white?.pitch ?? null;
}
