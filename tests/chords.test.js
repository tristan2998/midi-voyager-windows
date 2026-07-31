import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyChord, analyzeChords, chordAt, keyPitchClasses } from '../src/chords.js';

test('chord identification recognises common chords and inversions', () => {
  assert.equal(identifyChord([60, 64, 67], 60).name, 'C');
  assert.equal(identifyChord([57, 60, 64], 57).name, 'Am');
  assert.equal(identifyChord([64, 67, 72], 64).name, 'C/E');
  assert.equal(identifyChord([55, 59, 62, 65], 55).name, 'G7');
});

test('chord analysis merges adjacent slices and supports time lookup', () => {
  const notes = [60, 64, 67].map((pitch, index) => ({
    id: `n-${index}`, pitch, channel: 0, velocity: 100, start: 0, end: 2, duration: 2
  }));
  const model = {
    notes,
    totalTicks: 1920,
    ticksPerBeat: 480,
    tickToSeconds: (tick) => tick / 960
  };
  const analysis = analyzeChords(model, { key: { root: 0, minor: false, name: 'C major' } });
  assert.equal(analysis.segments[0].name, 'C');
  assert.equal(chordAt(analysis, 1).name, 'C');
  assert.deepEqual([...keyPitchClasses({ root: 0, minor: false })], [0, 2, 4, 5, 7, 9, 11]);
});

