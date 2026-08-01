import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { launchFilePaths, encodeOpenRequest, decodeOpenRequest } = require('../host/open-with.cjs');

test('Open With accepts every supported MIDI extension and ignores other files', () => {
  const accepted = launchFilePaths([
    'song.mid', 'arrangement.MIDI', 'lyrics.kar', 'wrapped.rmi', 'legacy.rmid', 'mobile.xmf', 'bank.sf2'
  ]);
  assert.deepEqual(accepted.map((file) => file.split('.').pop().toLowerCase()), ['mid', 'midi', 'kar', 'rmi', 'rmid', 'xmf']);
});

test('single-instance Open With messages preserve paths and focus intent', () => {
  const request = decodeOpenRequest(encodeOpenRequest(['one.mid', 'two.kar']).trim());
  assert.equal(request.focus, true);
  assert.deepEqual(request.paths.map((file) => file.split('.').pop()), ['mid', 'kar']);
});
