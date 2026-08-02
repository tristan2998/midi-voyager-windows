import test from 'node:test';
import assert from 'node:assert/strict';
import { PITCH_CLASS_COLORS } from '../src/constants.js';
import {
  activePianoKeyColor,
  aggregateSpectrumBands,
  mixerSliderColor,
  visualizerTrackColor
} from '../src/visualizer.js';

test('active piano keys use the exact colour of their falling note', () => {
  const colors = new Map([[60, '#58e6ff']]);
  const active = [];
  active[60] = true;
  assert.equal(activePianoKeyColor(60, colors, active), '#58e6ff');
});

test('live notes without a falling bar retain the pitch-colour fallback', () => {
  const active = [];
  active[61] = true;
  assert.equal(activePianoKeyColor(61, new Map(), active), PITCH_CLASS_COLORS[1]);
  assert.equal(activePianoKeyColor(62, new Map(), active), null);
});

test('mixer sliders use the same palette index as their primary visualiser track', () => {
  const tracks = [
    { index: 1, noteCount: 120, channels: [0] },
    { index: 5, noteCount: 20, channels: [0] }
  ];
  assert.equal(mixerSliderColor(tracks, 0, 'track'), visualizerTrackColor(1));
});

test('channel colour mode keeps mixer and visualiser channel colours aligned', () => {
  const tracks = [{ index: 7, noteCount: 120, channels: [2] }];
  assert.equal(mixerSliderColor(tracks, 2, 'channel'), '#ffc857');
});

test('spectrum analyser creates stable logarithmic bands', () => {
  const silent = aggregateSpectrumBands(new Uint8Array(256), 64);
  assert.equal(silent.length, 64);
  assert.equal([...silent].every((value) => value === 0), true);
  const signal = new Uint8Array(256);
  signal[2] = 255;
  signal[200] = 200;
  const bands = aggregateSpectrumBands(signal, 64);
  assert.equal(bands.length, 64);
  assert.ok(Math.max(...bands) > 0.5);
  assert.equal([...bands].every((value) => value >= 0 && value <= 1), true);
});
