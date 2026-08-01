import test from 'node:test';
import assert from 'node:assert/strict';
import { PITCH_CLASS_COLORS } from '../src/constants.js';
import { activePianoKeyColor } from '../src/visualizer.js';

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
