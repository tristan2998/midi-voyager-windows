import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, writeMidi } from 'midi-file';
import { AudioEngine } from '../src/audio-engine.js';

function oneNoteMIDI() {
  const bytes = Uint8Array.from(writeMidi({
    header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
    tracks: [[
      { deltaTime: 0, meta: true, type: 'trackName', text: 'Export test' },
      { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 0 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, meta: true, type: 'endOfTrack' }
    ]]
  }));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('modified MIDI export applies pitch/mixer state and inserts user markers', () => {
  const engine = new AudioEngine();
  engine.midiBuffer = oneNoteMIDI();
  engine.midiName = 'export-test.mid';
  engine.globalTranspose = 2;
  engine.channelState[0].volume = 0.75;
  engine.channelState[0].pan = -0.25;
  const output = engine.exportMIDI([{ time: 0.25, name: 'Verse', source: 'user' }]);
  const parsed = parseMidi(new Uint8Array(output));
  const events = parsed.tracks.flat();
  assert.equal(events.find((event) => event.type === 'noteOn').noteNumber, 62);
  assert.equal(events.find((event) => event.type === 'marker').text, 'Verse');
  assert.ok(events.some((event) => event.type === 'controller' && event.controllerType === 7));
  assert.ok(events.some((event) => event.type === 'controller' && event.controllerType === 10));
});

function soundBankHarness() {
  const engine = new AudioEngine();
  const calls = { added: [], deleted: [], orders: [] };
  const manager = {
    active: ['default'],
    async addSoundBank(buffer, id, bankOffset) {
      calls.added.push({ id, bankOffset, size: buffer.byteLength });
      if (!this.active.includes(id)) this.active.push(id);
    },
    async deleteSoundBank(id) {
      calls.deleted.push(id);
      this.active = this.active.filter((item) => item !== id);
    },
    set priorityOrder(order) {
      calls.orders.push([...order]);
      this.active = [...order];
    },
    get priorityOrder() { return [...this.active]; }
  };
  engine.synth = { soundBankManager: manager, midiChannels: [] };
  engine.soundBanks.set('default', {
    id: 'default', name: 'GeneralUser GS', buffer: new ArrayBuffer(8), bankOffset: 0, builtIn: true, enabled: true
  });
  engine.bankOrder = ['default'];
  return { engine, calls };
}

test('SoundFont stack supports live priority changes and enable toggles', async () => {
  const { engine, calls } = soundBankHarness();
  await engine.addSoundBank(new ArrayBuffer(12), 'Bank A', 0, 'A.sf2', { id: 'a' });
  await engine.addSoundBank(new ArrayBuffer(16), 'Bank B', 0, 'B.sf2', { id: 'b' });
  assert.deepEqual(engine.getSoundBanks().map((bank) => bank.id), ['b', 'a', 'default']);

  engine.setSoundBankOrder(['default', 'a', 'b']);
  assert.deepEqual(calls.orders.at(-1), ['default', 'a', 'b']);
  await engine.setSoundBankEnabled('a', false);
  assert.deepEqual(calls.deleted, ['a']);
  assert.deepEqual(calls.orders.at(-1), ['default', 'b']);
  assert.equal(engine.getSoundBanks().find((bank) => bank.id === 'a').enabled, false);

  await engine.setSoundBankEnabled('a', true);
  assert.equal(calls.added.at(-1).id, 'a');
  assert.deepEqual(calls.orders.at(-1), ['default', 'a', 'b']);
});

test('SoundFont stack never allows the final active bank to be disabled', async () => {
  const { engine } = soundBankHarness();
  await assert.rejects(engine.setSoundBankEnabled('default', false), /At least one SoundFont must remain enabled/);
  assert.equal(engine.getSoundBanks()[0].enabled, true);
});
