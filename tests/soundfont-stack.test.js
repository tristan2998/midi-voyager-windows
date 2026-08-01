import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SOUNDFONT_KEY,
  moveSoundBank,
  resolveSavedSoundBankOrder,
  soundFontStorageKey
} from '../src/soundfont-stack.js';

test('drag reordering places banks before or after the drop target', () => {
  const order = ['a', 'b', 'default'];
  assert.deepEqual(moveSoundBank(order, 'default', 'a'), ['default', 'a', 'b']);
  assert.deepEqual(moveSoundBank(order, 'a', 'b', true), ['b', 'a', 'default']);
  assert.deepEqual(moveSoundBank(order, 'a', 'a'), order);
});

test('saved paths and the built-in identifier resolve to current runtime IDs', () => {
  const banks = [
    { id: 'runtime-b', sourcePath: 'C:\\Banks\\B.sf2' },
    { id: 'default', builtIn: true },
    { id: 'runtime-a', sourcePath: 'C:\\Banks\\A.sf2' }
  ];
  const saved = [BUILTIN_SOUNDFONT_KEY, 'file:C:\\Banks\\A.sf2', 'file:C:\\Banks\\B.sf2'];
  assert.deepEqual(resolveSavedSoundBankOrder(banks, saved), ['default', 'runtime-a', 'runtime-b']);
  assert.equal(soundFontStorageKey(banks[1]), BUILTIN_SOUNDFONT_KEY);
});

test('legacy SoundFont arrays preserve their former newest-first priority', () => {
  const banks = [
    { id: 'default', builtIn: true },
    { id: 'first', sourcePath: 'first.sf2' },
    { id: 'second', sourcePath: 'second.sf2' }
  ];
  const legacy = [{ path: 'first.sf2' }, { path: 'second.sf2' }];
  assert.deepEqual(resolveSavedSoundBankOrder(banks, null, legacy), ['second', 'first', 'default']);
});
