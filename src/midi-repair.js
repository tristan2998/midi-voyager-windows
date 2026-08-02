import { parseMidi, writeMidi } from 'midi-file';

export const DEFAULT_REPAIR_OPTIONS = Object.freeze({
  closeStuckNotes: true,
  removeOrphanNoteOffs: true,
  normalizeZeroVelocity: true,
  resolveOverlaps: true,
  fixInvalidData: true,
  removeExactDuplicates: true,
  normalizeTrackEndings: true,
  clampTempos: true
});

const SAFE_DUPLICATE_TYPES = new Set([
  'controller', 'programChange', 'pitchBend', 'channelAftertouch',
  'setTempo', 'timeSignature', 'keySignature', 'trackName', 'instrumentName'
]);

const ISSUE_DEFINITIONS = [
  ['stuckNotes', 'Hanging notes', 'error', 'Notes that start but never receive a matching note-off.'],
  ['orphanNoteOffs', 'Orphan note-offs', 'warning', 'Note-off events without a corresponding active note.'],
  ['overlappingNotes', 'Overlapping retriggers', 'warning', 'The same channel and pitch is started again before it is released.'],
  ['zeroVelocityNoteOns', 'Zero-velocity note-ons', 'info', 'Legacy note-off encoding that can be normalised for compatibility.'],
  ['exactDuplicates', 'Duplicate state events', 'warning', 'Identical controller, program or metadata events at the same tick.'],
  ['invalidDeltaTimes', 'Invalid timing values', 'error', 'Negative or non-integer event delta times.'],
  ['invalidValues', 'Out-of-range MIDI values', 'error', 'Channel, note, velocity, controller or program values outside the MIDI range.'],
  ['trackEndings', 'Broken track endings', 'warning', 'Missing, repeated or prematurely placed end-of-track events.'],
  ['extremeTempos', 'Implausible tempos', 'warning', 'Tempo events outside the repair range of 20–300 BPM.']
];

function eventKind(event) {
  return event?.subtype || event?.type || '';
}

function setEventKind(event, kind) {
  if (Object.prototype.hasOwnProperty.call(event, 'subtype')) event.subtype = kind;
  else event.type = kind;
}

function parsedInput(input) {
  if (input?.header && Array.isArray(input.tracks)) return structuredClone(input);
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input instanceof ArrayBuffer ? input : input?.buffer || input);
  return parseMidi(bytes);
}

function emptyCounters() {
  return {
    stuckNotes: 0,
    orphanNoteOffs: 0,
    overlappingNotes: 0,
    zeroVelocityNoteOns: 0,
    exactDuplicates: 0,
    invalidDeltaTimes: 0,
    invalidValues: 0,
    trackEndings: 0,
    extremeTempos: 0
  };
}

function integerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function hasInvalidData(event) {
  if (event.channel !== undefined && !integerInRange(event.channel, 0, 15)) return true;
  const kind = eventKind(event);
  if (['noteOn', 'noteOff', 'noteAftertouch'].includes(kind)) {
    if (!integerInRange(event.noteNumber, 0, 127)) return true;
  }
  if (['noteOn', 'noteOff'].includes(kind) && !integerInRange(event.velocity ?? 0, 0, 127)) return true;
  if (kind === 'noteAftertouch' && !integerInRange(event.amount ?? 0, 0, 127)) return true;
  if (kind === 'controller' && (!integerInRange(event.controllerType, 0, 127) || !integerInRange(event.value, 0, 127))) return true;
  if (kind === 'programChange' && !integerInRange(event.programNumber, 0, 127)) return true;
  if (kind === 'channelAftertouch' && !integerInRange(event.amount ?? 0, 0, 127)) return true;
  if (kind === 'pitchBend' && (!Number.isInteger(event.value) || event.value < -8192 || event.value > 8191)) return true;
  return false;
}

function duplicateSignature(event) {
  const kind = eventKind(event);
  if (!SAFE_DUPLICATE_TYPES.has(kind)) return null;
  const fields = {
    kind,
    channel: event.channel,
    controllerType: event.controllerType,
    value: event.value,
    programNumber: event.programNumber,
    amount: event.amount,
    microsecondsPerBeat: event.microsecondsPerBeat,
    numerator: event.numerator,
    denominator: event.denominator,
    key: event.key,
    scale: event.scale,
    text: event.text
  };
  return JSON.stringify(fields);
}

function reportFromCounters(counters, trackCount, eventCount) {
  const issues = ISSUE_DEFINITIONS
    .map(([code, label, severity, description]) => ({ code, label, severity, description, count: counters[code] || 0 }))
    .filter((issue) => issue.count > 0);
  return {
    counters,
    issues,
    totalIssues: issues.reduce((sum, issue) => sum + issue.count, 0),
    errorCount: issues.filter((issue) => issue.severity === 'error').reduce((sum, issue) => sum + issue.count, 0),
    trackCount,
    eventCount,
    healthy: issues.length === 0
  };
}

export function inspectMIDI(input) {
  const parsed = parsedInput(input);
  const counters = emptyCounters();
  let eventCount = 0;

  for (const track of parsed.tracks) {
    const active = new Map();
    let tick = 0;
    let lastTick = -1;
    let duplicateKeys = new Set();
    const endIndexes = [];

    track.forEach((event, index) => {
      eventCount += 1;
      const validDelta = Number.isInteger(event.deltaTime) && event.deltaTime >= 0;
      if (!validDelta) counters.invalidDeltaTimes += 1;
      tick += validDelta ? event.deltaTime : Math.max(0, Math.round(Number(event.deltaTime) || 0));
      if (tick !== lastTick) {
        duplicateKeys = new Set();
        lastTick = tick;
      }

      if (hasInvalidData(event)) counters.invalidValues += 1;
      const kind = eventKind(event);
      if (kind === 'setTempo' && event.microsecondsPerBeat > 0) {
        const bpm = 60_000_000 / event.microsecondsPerBeat;
        if (bpm < 20 || bpm > 300) counters.extremeTempos += 1;
      }
      const signature = duplicateSignature(event);
      if (signature) {
        if (duplicateKeys.has(signature)) counters.exactDuplicates += 1;
        duplicateKeys.add(signature);
      }
      if (kind === 'endOfTrack') endIndexes.push(index);

      const channel = Math.max(0, Math.min(15, Math.round(Number(event.channel) || 0)));
      const note = Math.max(0, Math.min(127, Math.round(Number(event.noteNumber) || 0)));
      const noteKey = `${channel}:${note}`;
      if (kind === 'noteOn' && Number(event.velocity) === 0) counters.zeroVelocityNoteOns += 1;
      if (kind === 'noteOn' && Number(event.velocity) > 0) {
        const count = active.get(noteKey) || 0;
        if (count > 0) counters.overlappingNotes += 1;
        active.set(noteKey, count + 1);
      } else if (kind === 'noteOff' || (kind === 'noteOn' && Number(event.velocity) === 0)) {
        const count = active.get(noteKey) || 0;
        if (count < 1) counters.orphanNoteOffs += 1;
        else if (count === 1) active.delete(noteKey);
        else active.set(noteKey, count - 1);
      }
    });

    counters.stuckNotes += [...active.values()].reduce((sum, count) => sum + count, 0);
    if (endIndexes.length !== 1 || endIndexes[0] !== track.length - 1) counters.trackEndings += 1;
  }

  return reportFromCounters(counters, parsed.tracks.length, eventCount);
}

function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function repairEventValues(event, fixes) {
  const repaired = { ...event };
  let changed = false;
  const assign = (field, value) => {
    if (repaired[field] !== value) {
      repaired[field] = value;
      changed = true;
    }
  };
  if (repaired.channel !== undefined) assign('channel', clampInteger(repaired.channel, 0, 15));
  const kind = eventKind(repaired);
  if (['noteOn', 'noteOff', 'noteAftertouch'].includes(kind)) assign('noteNumber', clampInteger(repaired.noteNumber, 0, 127));
  if (['noteOn', 'noteOff'].includes(kind)) assign('velocity', clampInteger(repaired.velocity, 0, 127));
  if (kind === 'noteAftertouch') assign('amount', clampInteger(repaired.amount, 0, 127));
  if (kind === 'controller') {
    assign('controllerType', clampInteger(repaired.controllerType, 0, 127));
    assign('value', clampInteger(repaired.value, 0, 127));
  }
  if (kind === 'programChange') assign('programNumber', clampInteger(repaired.programNumber, 0, 127));
  if (kind === 'channelAftertouch') assign('amount', clampInteger(repaired.amount, 0, 127));
  if (kind === 'pitchBend') assign('value', clampInteger(repaired.value, -8192, 8191));
  if (changed) fixes.invalidValues += 1;
  return repaired;
}

function noteOffFor(event) {
  return {
    deltaTime: 0,
    type: 'noteOff',
    channel: event.channel,
    noteNumber: event.noteNumber,
    velocity: 0
  };
}

export function repairMIDI(input, requestedOptions = {}) {
  const parsed = parsedInput(input);
  const before = inspectMIDI(parsed);
  const options = { ...DEFAULT_REPAIR_OPTIONS, ...requestedOptions };
  const fixes = emptyCounters();
  let sequence = 0;

  const tracks = parsed.tracks.map((track) => {
    const originalEndIndexes = track
      .map((event, index) => eventKind(event) === 'endOfTrack' ? index : -1)
      .filter((index) => index >= 0);
    const brokenTrackEnding = originalEndIndexes.length !== 1 || originalEndIndexes[0] !== track.length - 1;
    const active = new Map();
    const records = [];
    let tick = 0;
    let lastTick = -1;
    let duplicateKeys = new Set();
    let endTick = 0;

    const push = (event, atTick, order = sequence++) => records.push({ event, tick: atTick, order });
    for (const original of track) {
      let delta = Number(original.deltaTime);
      if (!Number.isInteger(delta) || delta < 0) {
        if (options.fixInvalidData) {
          delta = Math.max(0, Math.round(delta || 0));
          fixes.invalidDeltaTimes += 1;
        } else {
          delta = Math.max(0, Math.round(delta || 0));
        }
      }
      tick += delta;
      endTick = Math.max(endTick, tick);
      let event = { ...original, deltaTime: 0 };
      if (options.fixInvalidData) event = repairEventValues(event, fixes);
      let kind = eventKind(event);

      if (kind === 'setTempo' && options.clampTempos && event.microsecondsPerBeat > 0) {
        const bpm = 60_000_000 / event.microsecondsPerBeat;
        if (bpm < 20 || bpm > 300) {
          event.microsecondsPerBeat = Math.round(60_000_000 / Math.max(20, Math.min(300, bpm)));
          fixes.extremeTempos += 1;
        }
      }
      if (kind === 'noteOn' && Number(event.velocity) === 0 && options.normalizeZeroVelocity) {
        setEventKind(event, 'noteOff');
        event.velocity = 0;
        kind = 'noteOff';
        fixes.zeroVelocityNoteOns += 1;
      }

      if (kind === 'endOfTrack' && options.normalizeTrackEndings) {
        continue;
      }

      if (tick !== lastTick) {
        duplicateKeys = new Set();
        lastTick = tick;
      }
      const signature = duplicateSignature(event);
      if (signature && options.removeExactDuplicates && duplicateKeys.has(signature)) {
        fixes.exactDuplicates += 1;
        continue;
      }
      if (signature) duplicateKeys.add(signature);

      const channel = clampInteger(event.channel, 0, 15);
      const note = clampInteger(event.noteNumber, 0, 127);
      const noteKey = `${channel}:${note}`;
      if (kind === 'noteOn' && Number(event.velocity) > 0) {
        let starts = active.get(noteKey) || [];
        if (starts.length && options.resolveOverlaps) {
          push(noteOffFor(starts[starts.length - 1]), tick, sequence++ - 0.5);
          fixes.overlappingNotes += starts.length;
          starts = [];
        }
        starts.push(event);
        active.set(noteKey, starts);
      } else if (kind === 'noteOff') {
        const starts = active.get(noteKey) || [];
        if (!starts.length && options.removeOrphanNoteOffs) {
          fixes.orphanNoteOffs += 1;
          continue;
        }
        if (starts.length === 1) active.delete(noteKey);
        else if (starts.length > 1) starts.shift();
      }
      push(event, tick);
    }

    if (options.closeStuckNotes) {
      for (const starts of active.values()) {
        for (const start of starts) {
          push(noteOffFor(start), endTick);
          fixes.stuckNotes += 1;
        }
      }
    }
    if (options.normalizeTrackEndings) {
      push({ deltaTime: 0, meta: true, type: 'endOfTrack' }, endTick, Number.MAX_SAFE_INTEGER);
      if (brokenTrackEnding) fixes.trackEndings += 1;
    }

    records.sort((left, right) => left.tick - right.tick || left.order - right.order);
    let previousTick = 0;
    return records.map(({ event, tick: eventTick }) => {
      const output = { ...event, deltaTime: Math.max(0, eventTick - previousTick) };
      previousTick = eventTick;
      return output;
    });
  });

  const repairedParsed = {
    header: { ...parsed.header, numTracks: tracks.length },
    tracks
  };
  const written = new Uint8Array(writeMidi(repairedParsed));
  const fixedTotal = Object.values(fixes).reduce((sum, count) => sum + count, 0);
  const after = inspectMIDI(repairedParsed);
  return {
    buffer: written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength),
    parsed: repairedParsed,
    before,
    after,
    fixes,
    fixedTotal,
    changed: fixedTotal > 0
  };
}
