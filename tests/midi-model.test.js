import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMidi } from 'midi-file';
import { MIDIModel, estimateKey, keySignatureName } from '../src/midi-model.js';

function fixtureBuffer() {
  const midi = {
    header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
    tracks: [
      [
        { deltaTime: 0, meta: true, type: 'trackName', text: 'Conductor' },
        { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 500_000 },
        { deltaTime: 0, meta: true, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
        { deltaTime: 0, meta: true, type: 'keySignature', key: 0, scale: 0 },
        { deltaTime: 0, meta: true, type: 'lyrics', text: 'Hello world' },
        { deltaTime: 960, meta: true, type: 'marker', text: 'Slow section' },
        { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 1_000_000 },
        { deltaTime: 480, meta: true, type: 'endOfTrack' }
      ],
      [
        { deltaTime: 0, meta: true, type: 'trackName', text: 'Piano' },
        { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 0 },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
        { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 90 },
        { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 67, velocity: 80 },
        { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 67, velocity: 0 },
        { deltaTime: 0, meta: true, type: 'endOfTrack' }
      ]
    ]
  };
  const bytes = Uint8Array.from(writeMidi(midi));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('MIDIModel parses standard midi-file event types and tempo changes', () => {
  const model = new MIDIModel(fixtureBuffer(), 'fixture.mid');
  assert.equal(model.format, 1);
  assert.equal(model.tracks.length, 2);
  assert.equal(model.tracks[1].name, 'Piano');
  assert.equal(model.tracks[1].program, 0);
  assert.equal(model.notes.length, 3);
  assert.equal(model.notesByChannel[0].length, 3);
  assert.deepEqual(model.noteRange, { min: 60, max: 67 });
  assert.equal(model.lyrics[0].text, 'Hello world');
  assert.equal(model.markers[0].name, 'Slow section');
  assert.equal(model.markers[0].time, 1);
  assert.equal(model.tempoAt(0.75), 120);
  assert.equal(model.tempoAt(1.25), 60);
  assert.equal(model.tickToSeconds(1440), 2);
  assert.equal(model.secondsToTick(2), 1440);
  assert.equal(model.duration, 2);
  assert.equal(model.stats.channels, 1);
  assert.equal(model.stats.notes, 3);
});

test('MIDIModel range queries, lyrics and musical helpers are stable', () => {
  const model = new MIDIModel(fixtureBuffer(), 'fixture.mid');
  assert.deepEqual(model.notesInRange(0.45, 0.55).map((note) => note.pitch), [60, 64]);
  assert.equal(model.lyricAt(0.1).current.text, 'Hello world');
  assert.match(estimateKey(model.notes).name, /major|minor/);
  assert.equal(keySignatureName(0, 0), 'C major');
  assert.equal(keySignatureName(0, 1), 'A minor');
});

