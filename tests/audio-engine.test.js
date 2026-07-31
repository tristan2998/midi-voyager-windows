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

