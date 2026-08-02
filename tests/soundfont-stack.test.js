import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SOUNDFONT_KEY,
  moveSoundBank,
  normalizeBankOffset,
  resolveSavedSoundBankOrder,
  soundFontStorageKey,
  summarizeSoundBank
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

test('bank offsets are normalised to the MIDI bank range', () => {
  assert.equal(normalizeBankOffset(-10), 0);
  assert.equal(normalizeBankOffset(12.6), 13);
  assert.equal(normalizeBankOffset(999), 127);
});

test('sound bank metadata is shaped for the preset browser', () => {
  const summary = summarizeSoundBank({
    type: 'sf2',
    soundBankInfo: { name: 'Test Bank', engineer: 'Voyager', version: { major: 2, minor: 4 } },
    instruments: [{}, {}],
    samples: [{}, {}, {}],
    presets: [
      { name: 'Grand', program: 0, bankMSB: 0, bankLSB: 0, isDrum: false },
      { name: 'Room Kit', program: 0, bankMSB: 128, bankLSB: 0, isDrum: true }
    ]
  });
  assert.equal(summary.internalName, 'Test Bank');
  assert.equal(summary.author, 'Voyager');
  assert.equal(summary.version, '2.4');
  assert.equal(summary.presetCount, 2);
  assert.equal(summary.drumPresetCount, 1);
  assert.equal(summary.instrumentCount, 2);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.presets[1].isDrum, true);
  assert.equal(summary.presets[1].bankMSB, 128);
});
