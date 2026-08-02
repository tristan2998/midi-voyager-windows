import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMIDI, repairMIDI } from '../src/midi-repair.js';

function brokenMIDI() {
  return {
    header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
    tracks: [[
      { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
      { deltaTime: 120, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 90 },
      { deltaTime: 120, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 0 },
      { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 110 },
      { deltaTime: 0, type: 'controller', channel: 0, controllerType: 7, value: 110 },
      { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 50_000 },
      { deltaTime: 0, meta: true, type: 'endOfTrack' },
      { deltaTime: 10, type: 'noteOn', channel: 18, noteNumber: 200, velocity: 200 }
    ]]
  };
}

test('MIDI inspection identifies repairable structural problems', () => {
  const report = inspectMIDI(brokenMIDI());
  assert.equal(report.counters.orphanNoteOffs, 1);
  assert.equal(report.counters.overlappingNotes, 1);
  assert.equal(report.counters.zeroVelocityNoteOns, 1);
  assert.equal(report.counters.exactDuplicates, 1);
  assert.equal(report.counters.extremeTempos, 1);
  assert.equal(report.counters.invalidValues, 1);
  assert.equal(report.counters.trackEndings, 1);
  assert.ok(report.counters.stuckNotes >= 1);
  assert.equal(report.healthy, false);
});

test('MIDI repair creates a clean, parseable copy without changing track count', () => {
  const result = repairMIDI(brokenMIDI());
  assert.equal(result.changed, true);
  assert.ok(result.fixedTotal > 0);
  assert.equal(result.parsed.tracks.length, 1);
  assert.equal(result.after.healthy, true);
  assert.ok(result.buffer.byteLength > 20);
  const events = result.parsed.tracks[0];
  assert.equal(events.at(-1).type, 'endOfTrack');
  assert.equal(events.filter((event) => event.type === 'endOfTrack').length, 1);
  assert.equal(events.some((event) => event.type === 'noteOn' && event.velocity === 0), false);
  assert.equal(events.some((event) => event.channel > 15 || event.noteNumber > 127 || event.velocity > 127), false);
});

test('individual repair switches can leave selected compatibility events untouched', () => {
  const result = repairMIDI(brokenMIDI(), {
    normalizeZeroVelocity: false,
    removeExactDuplicates: false,
    clampTempos: false
  });
  const events = result.parsed.tracks[0];
  assert.equal(events.some((event) => event.type === 'noteOn' && event.velocity === 0), true);
  assert.equal(events.filter((event) => event.type === 'controller').length, 2);
  assert.equal(events.find((event) => event.type === 'setTempo').microsecondsPerBeat, 50_000);
});
