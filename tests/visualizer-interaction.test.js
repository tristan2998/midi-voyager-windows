import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedWheelPixels,
  visualizerScrollSeconds,
  visualizerZoomMultiplier
} from '../src/visualizer-interaction.js';

test('wheel normalization supports mouse wheels, trackpads and horizontal gestures', () => {
  assert.equal(normalizedWheelPixels(0, 120, 0), 120);
  assert.equal(normalizedWheelPixels(0, 3, 1), 48);
  assert.equal(normalizedWheelPixels(-80, 20, 0), -80);
});

test('plain wheel movement scrolls forward and back through visualiser time', () => {
  assert.ok(visualizerScrollSeconds(0, 100, 0, 1, 'roll') > 0);
  assert.ok(visualizerScrollSeconds(0, -100, 0, 1, 'roll') < 0);
  assert.ok(Math.abs(visualizerScrollSeconds(0, 100, 0, 4, 'roll'))
    < Math.abs(visualizerScrollSeconds(0, 100, 0, 1, 'roll')));
});

test('Ctrl-wheel zoom direction follows Windows conventions', () => {
  assert.ok(visualizerZoomMultiplier(0, -100, 0) > 1);
  assert.ok(visualizerZoomMultiplier(0, 100, 0) < 1);
  assert.equal(visualizerZoomMultiplier(0, 0, 0), 1);
});
