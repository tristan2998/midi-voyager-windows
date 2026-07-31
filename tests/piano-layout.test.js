import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK_KEY_HEIGHT_RATIO,
  createPianoLayout,
  pianoPitchAt,
  visiblePianoRange
} from '../src/piano-layout.js';

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not close to ${expected}`);
}

test('one octave uses seven equal white keys and correctly grouped black keys', () => {
  const layout = createPianoLayout(60, 71, 700);
  assert.equal(layout.whiteKeys.length, 7);
  assert.equal(layout.blackKeys.length, 5);
  assert.deepEqual(layout.blackKeys.map((key) => key.pitch), [61, 63, 66, 68, 70]);
  layout.whiteKeys.forEach((key) => closeTo(key.width, 100));
  assert.deepEqual(layout.blackKeys.map((key) => Math.round(key.center)), [100, 200, 400, 500, 600]);
  layout.blackKeys.forEach((key) => closeTo(key.width, 62));
});

test('an 88-key source range stays exactly A0 through C8', () => {
  const range = visiblePianoRange({ min: 21, max: 108 }, 1);
  assert.deepEqual(range, { min: 21, max: 108, count: 88 });
  const layout = createPianoLayout(range.min, range.max, 1040);
  assert.equal(layout.keys.length, 88);
  assert.equal(layout.whiteKeys.length, 52);
  assert.equal(layout.blackKeys.length, 36);
});

test('keyboard hit-testing prioritises black keys only over their visible height', () => {
  const layout = createPianoLayout(60, 71, 700);
  const height = 100;
  assert.equal(pianoPitchAt(layout, 50, 90, height), 60);
  assert.equal(pianoPitchAt(layout, 100, 10, height), 61);
  assert.equal(pianoPitchAt(layout, 100, height * BLACK_KEY_HEIGHT_RATIO + 1, height), 62);
  assert.equal(pianoPitchAt(layout, 300, 10, height), 65);
  assert.equal(pianoPitchAt(layout, 700, 90, height), 71);
  assert.equal(pianoPitchAt(layout, -1, 10, height), null);
});

test('ranges ending on black notes include the neighbouring white-key bed', () => {
  const layout = createPianoLayout(61, 70, 700);
  assert.equal(layout.min, 60);
  assert.equal(layout.max, 71);
  assert.equal(layout.whiteKeys.length, 7);
  assert.equal(layout.blackKeys.length, 5);
});
