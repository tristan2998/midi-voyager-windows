import { NOTE_NAMES_FLAT, NOTE_NAMES_SHARP } from './constants.js';
import { estimateKey } from './midi-model.js';

const TEMPLATES = [
  { suffix: '', intervals: [0, 4, 7], priority: 8 },
  { suffix: 'm', intervals: [0, 3, 7], priority: 8 },
  { suffix: '5', intervals: [0, 7], priority: 2 },
  { suffix: 'dim', intervals: [0, 3, 6], priority: 6 },
  { suffix: 'aug', intervals: [0, 4, 8], priority: 6 },
  { suffix: 'sus2', intervals: [0, 2, 7], priority: 5 },
  { suffix: 'sus4', intervals: [0, 5, 7], priority: 5 },
  { suffix: '6', intervals: [0, 4, 7, 9], priority: 6 },
  { suffix: 'm6', intervals: [0, 3, 7, 9], priority: 6 },
  { suffix: '7', intervals: [0, 4, 7, 10], priority: 10 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], priority: 10 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], priority: 10 },
  { suffix: 'm(maj7)', intervals: [0, 3, 7, 11], priority: 7 },
  { suffix: 'ø7', intervals: [0, 3, 6, 10], priority: 8 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], priority: 8 },
  { suffix: '7sus4', intervals: [0, 5, 7, 10], priority: 7 },
  { suffix: 'add9', intervals: [0, 2, 4, 7], priority: 6 },
  { suffix: 'madd9', intervals: [0, 2, 3, 7], priority: 6 },
  { suffix: '9', intervals: [0, 2, 4, 7, 10], priority: 9 },
  { suffix: 'maj9', intervals: [0, 2, 4, 7, 11], priority: 8 },
  { suffix: 'm9', intervals: [0, 2, 3, 7, 10], priority: 8 }
];

function chooseNames(key) {
  if (!key) return NOTE_NAMES_SHARP;
  const flatRoots = new Set([1, 3, 5, 8, 10]);
  return flatRoots.has(key.root) ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
}

export function identifyChord(pitches, bassPitch = null, key = null) {
  const pitchClasses = new Set(pitches.map((pitch) => ((pitch % 12) + 12) % 12));
  if (!pitchClasses.size) return null;
  const names = chooseNames(key);
  if (pitchClasses.size === 1) {
    const root = [...pitchClasses][0];
    return { name: names[root], root, suffix: '', confidence: 0.35, pitchClasses: [...pitchClasses] };
  }

  let best = null;
  for (let root = 0; root < 12; root += 1) {
    for (const template of TEMPLATES) {
      const expected = new Set(template.intervals.map((interval) => (root + interval) % 12));
      let hits = 0;
      let missing = 0;
      let extras = 0;
      for (const note of expected) pitchClasses.has(note) ? hits++ : missing++;
      for (const note of pitchClasses) if (!expected.has(note)) extras++;
      const rootBonus = pitchClasses.has(root) ? 2.3 : -2;
      const bassClass = bassPitch === null ? -1 : ((bassPitch % 12) + 12) % 12;
      const bassBonus = bassClass === root ? 1.5 : (expected.has(bassClass) ? 0.25 : -0.5);
      const score = hits * 3.2 - missing * 3.8 - extras * 1.25 + rootBonus + bassBonus + template.priority * 0.03;
      if (!best || score > best.score) best = { root, template, score, hits, missing, extras, bassClass };
    }
  }

  if (!best) return null;
  const baseName = `${names[best.root]}${best.template.suffix}`;
  const inversion = best.bassClass >= 0 && best.bassClass !== best.root &&
    best.template.intervals.some((interval) => (best.root + interval) % 12 === best.bassClass)
    ? `/${names[best.bassClass]}`
    : '';
  const denominator = best.template.intervals.length * 3.2 + 3.8;
  const confidence = Math.max(0, Math.min(1, (best.score + 3.8) / denominator));
  return {
    name: `${baseName}${inversion}`,
    root: best.root,
    suffix: best.template.suffix,
    inversion: best.bassClass,
    confidence,
    pitchClasses: [...pitchClasses]
  };
}

export function analyzeChords(model, options = {}) {
  const key = options.key || estimateKey(model.notes);
  const totalBeats = Math.max(1, Math.ceil(model.totalTicks / model.ticksPerBeat));
  const stride = Math.max(1, Math.ceil(totalBeats / (options.maxSlices || 12_000)));
  const starts = [...model.notes].sort((a, b) => a.start - b.start);
  const ends = [...model.notes].sort((a, b) => a.end - b.end);
  const active = new Map();
  let startIndex = 0;
  let endIndex = 0;
  const slices = [];

  for (let beat = 0; beat <= totalBeats; beat += stride) {
    const tick = beat * model.ticksPerBeat;
    const time = model.tickToSeconds(tick);
    while (startIndex < starts.length && starts[startIndex].start <= time + 0.02) {
      active.set(starts[startIndex].id, starts[startIndex]);
      startIndex++;
    }
    while (endIndex < ends.length && ends[endIndex].end < time - 0.02) {
      active.delete(ends[endIndex].id);
      endIndex++;
    }
    const sounding = [...active.values()].filter((note) => note.channel !== 9);
    const pitches = sounding.map((note) => note.pitch);
    const bass = pitches.length ? Math.min(...pitches) : null;
    const chord = identifyChord(pitches, bass, key);
    slices.push({
      time,
      tick,
      beat,
      endTime: model.tickToSeconds(Math.min(model.totalTicks, tick + stride * model.ticksPerBeat)),
      chord,
      name: chord?.name || '—',
      manual: false
    });
  }

  const segments = [];
  for (const slice of slices) {
    const previous = segments[segments.length - 1];
    if (previous && previous.name === slice.name && !previous.manual) {
      previous.endTime = Math.max(previous.endTime, slice.endTime);
      previous.endTick = Math.max(previous.endTick, slice.tick + stride * model.ticksPerBeat);
      previous.confidence = Math.max(previous.confidence, slice.chord?.confidence || 0);
    } else {
      segments.push({
        startTime: slice.time,
        endTime: slice.endTime,
        startTick: slice.tick,
        endTick: slice.tick + stride * model.ticksPerBeat,
        name: slice.name,
        root: slice.chord?.root ?? null,
        confidence: slice.chord?.confidence || 0,
        manual: false
      });
    }
  }

  return { key, slices, segments, stride };
}

export function chordAt(analysis, seconds) {
  if (!analysis?.segments?.length) return null;
  let low = 0;
  let high = analysis.segments.length - 1;
  let answer = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (analysis.segments[middle].startTime <= seconds) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return analysis.segments[answer];
}

export function keyPitchClasses(key) {
  if (!key) return new Set();
  const intervals = key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return new Set(intervals.map((interval) => (key.root + interval) % 12));
}
