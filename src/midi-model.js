import { parseMidi } from 'midi-file';
import { GM_PROGRAMS, NOTE_NAMES_FLAT, NOTE_NAMES_SHARP, midiNoteName } from './constants.js';

const MAX_EVENT_ROWS = 200_000;

function cleanText(value) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .replace(/^@[A-Z].*$/i, '')
    .trim();
}

function eventKind(event) {
  return event.subtype || event.type || '';
}

function eventDescription(event) {
  switch (eventKind(event)) {
    case 'noteOn': return `Note on ${midiNoteName(event.noteNumber)} · velocity ${event.velocity}`;
    case 'noteOff': return `Note off ${midiNoteName(event.noteNumber)}`;
    case 'programChange': return `Program ${event.programNumber + 1} · ${GM_PROGRAMS[event.programNumber] ?? 'Unknown'}`;
    case 'controller': return `CC ${event.controllerType} = ${event.value}`;
    case 'pitchBend': return `Pitch bend ${event.value}`;
    case 'setTempo': return `Tempo ${Math.round(60_000_000 / event.microsecondsPerBeat)} BPM`;
    case 'timeSignature': return `Time signature ${event.numerator}/${event.denominator}`;
    case 'keySignature': return `Key signature ${event.key ?? ''} ${event.scale ? 'minor' : 'major'}`.trim();
    case 'trackName': return `Track name · ${event.text}`;
    case 'instrumentName': return `Instrument · ${event.text}`;
    case 'lyrics':
    case 'lyric': return `Lyric · ${event.text}`;
    case 'marker': return `Marker · ${event.text}`;
    case 'text': return `Text · ${event.text}`;
    default: return eventKind(event) || 'MIDI event';
  }
}

function binarySearchLast(items, value, getter) {
  let low = 0;
  let high = items.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (getter(items[mid]) <= value) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

export class MIDIModel {
  constructor(arrayBuffer, fileName = 'Untitled.mid') {
    this.fileName = fileName;
    this.arrayBuffer = arrayBuffer.slice(0);
    this.parsed = parseMidi(new Uint8Array(arrayBuffer));
    this.header = this.parsed.header;
    this.format = this.header.format ?? 1;
    this.ticksPerBeat = this.header.ticksPerBeat || 480;
    this.tracks = [];
    this.notes = [];
    this.notesByChannel = Array.from({ length: 16 }, () => []);
    this.lyrics = [];
    this.markers = [];
    this.events = [];
    this.tempoMap = [];
    this.timeSignatures = [];
    this.keySignatures = [];
    this.totalTicks = 0;
    this.duration = 0;
    this.noteRange = { min: 127, max: 0 };
    this.eventCount = 0;
    this._parse();
  }

  _parse() {
    const stagedTracks = [];
    const tempoEvents = [];
    const timeSignatures = [];
    const keySignatures = [];

    this.parsed.tracks.forEach((rawTrack, trackIndex) => {
      let tick = 0;
      const events = [];
      const channels = new Set();
      let name = `Track ${trackIndex + 1}`;
      let instrumentName = '';
      let program = null;

      rawTrack.forEach((event, eventIndex) => {
        tick += event.deltaTime || 0;
        const kind = eventKind(event);
        const staged = { ...event, kind, tick, track: trackIndex, eventIndex };
        events.push(staged);
        this.eventCount += 1;
        this.totalTicks = Math.max(this.totalTicks, tick);

        if (event.channel !== undefined) channels.add(event.channel);
        if (kind === 'trackName' && cleanText(event.text)) name = cleanText(event.text);
        if (kind === 'instrumentName' && cleanText(event.text)) instrumentName = cleanText(event.text);
        if (kind === 'programChange' && program === null) program = event.programNumber;
        if (kind === 'setTempo' && event.microsecondsPerBeat) tempoEvents.push(staged);
        if (kind === 'timeSignature') timeSignatures.push(staged);
        if (kind === 'keySignature') keySignatures.push(staged);
      });

      stagedTracks.push({
        index: trackIndex,
        name,
        instrumentName,
        program,
        channels: [...channels].sort((a, b) => a - b),
        events,
        noteCount: 0,
        colorIndex: trackIndex % 16
      });
    });

    const mergedTempo = [{ tick: 0, microsecondsPerBeat: 500_000 }];
    tempoEvents.sort((a, b) => a.tick - b.tick || a.track - b.track).forEach((item) => {
      const previous = mergedTempo[mergedTempo.length - 1];
      if (previous.tick === item.tick) previous.microsecondsPerBeat = item.microsecondsPerBeat;
      else mergedTempo.push({ tick: item.tick, microsecondsPerBeat: item.microsecondsPerBeat });
    });

    let runningSeconds = 0;
    for (let i = 0; i < mergedTempo.length; i += 1) {
      const current = mergedTempo[i];
      if (i > 0) {
        const previous = mergedTempo[i - 1];
        runningSeconds += (current.tick - previous.tick) * previous.microsecondsPerBeat / this.ticksPerBeat / 1_000_000;
      }
      current.seconds = runningSeconds;
      current.bpm = 60_000_000 / current.microsecondsPerBeat;
    }
    this.tempoMap = mergedTempo;

    this.timeSignatures = timeSignatures
      .sort((a, b) => a.tick - b.tick)
      .map((item) => ({
        tick: item.tick,
        seconds: this.tickToSeconds(item.tick),
        numerator: item.numerator || 4,
        denominator: item.denominator || 4,
        metronome: item.metronome || 24
      }));
    if (!this.timeSignatures.length || this.timeSignatures[0].tick !== 0) {
      this.timeSignatures.unshift({ tick: 0, seconds: 0, numerator: 4, denominator: 4, metronome: 24 });
    }

    this.keySignatures = keySignatures
      .sort((a, b) => a.tick - b.tick)
      .map((item) => ({
        tick: item.tick,
        seconds: this.tickToSeconds(item.tick),
        key: item.key ?? 0,
        scale: item.scale ?? 0,
        name: keySignatureName(item.key ?? 0, item.scale ?? 0)
      }));

    stagedTracks.forEach((track) => this._finishTrack(track));
    this.tracks = stagedTracks;
    this.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.track - b.track);
    this.lyrics.sort((a, b) => a.time - b.time || a.track - b.track);
    this.markers.sort((a, b) => a.time - b.time);
    this.events.sort((a, b) => a.time - b.time || a.track - b.track || a.index - b.index);
    this.duration = Math.max(this.tickToSeconds(this.totalTicks), ...this.notes.map((note) => note.end), 0);
    if (this.noteRange.min > this.noteRange.max) this.noteRange = { min: 36, max: 84 };
    this._buildDensityMap();
  }

  _finishTrack(track) {
    const active = new Map();
    const closeNote = (event) => {
      const key = `${event.channel}:${event.noteNumber}`;
      const stack = active.get(key);
      if (!stack?.length) return;
      const start = stack.shift();
      const startTime = this.tickToSeconds(start.tick);
      const endTime = Math.max(startTime + 0.015, this.tickToSeconds(event.tick));
      const note = {
        id: `${track.index}-${start.eventIndex}`,
        track: track.index,
        channel: start.channel,
        pitch: start.noteNumber,
        velocity: start.velocity,
        start: startTime,
        end: endTime,
        duration: endTime - startTime,
        startTick: start.tick,
        endTick: event.tick
      };
      this.notes.push(note);
      this.notesByChannel[note.channel]?.push(note);
      track.noteCount += 1;
      this.noteRange.min = Math.min(this.noteRange.min, note.pitch);
      this.noteRange.max = Math.max(this.noteRange.max, note.pitch);
    };

    track.events.forEach((event, index) => {
      const time = this.tickToSeconds(event.tick);
      const kind = event.kind || eventKind(event);
      if (kind === 'noteOn' && event.velocity > 0) {
        const key = `${event.channel}:${event.noteNumber}`;
        if (!active.has(key)) active.set(key, []);
        active.get(key).push(event);
      } else if (kind === 'noteOff' || (kind === 'noteOn' && event.velocity === 0)) {
        closeNote(event);
      }

      if (kind === 'lyrics' || kind === 'lyric' || kind === 'text') {
        const text = cleanText(event.text);
        if (text && !/^%|^@/.test(text)) this.lyrics.push({ time, tick: event.tick, text, track: track.index });
      }
      if (kind === 'marker' || kind === 'cuePoint') {
        const text = cleanText(event.text) || `Marker ${this.markers.length + 1}`;
        this.markers.push({ time, tick: event.tick, name: text, source: 'file' });
      }

      if (this.events.length < MAX_EVENT_ROWS) {
        const isUseful = event.channel !== undefined || [
          'setTempo', 'timeSignature', 'keySignature', 'trackName', 'instrumentName',
          'lyrics', 'lyric', 'text', 'marker', 'cuePoint'
        ].includes(kind);
        if (isUseful) {
          this.events.push({
            time,
            tick: event.tick,
            track: track.index,
            channel: event.channel,
            type: kind,
            description: eventDescription(event),
            index
          });
        }
      }
    });

    const endEvent = { tick: this.totalTicks };
    for (const stack of active.values()) {
      while (stack.length) {
        const start = stack[0];
        closeNote({ ...endEvent, channel: start.channel, noteNumber: start.noteNumber });
      }
    }
  }

  _buildDensityMap() {
    const buckets = Math.min(4096, Math.max(256, Math.ceil(this.duration * 4)));
    this.densityBucketDuration = this.duration / buckets || 1;
    this.density = Array.from({ length: buckets }, () => new Uint16Array(128));
    for (const note of this.notes) {
      const bucket = Math.min(buckets - 1, Math.floor(note.start / this.densityBucketDuration));
      const current = this.density[bucket][note.pitch];
      this.density[bucket][note.pitch] = Math.min(65535, current + 1);
    }
  }

  tickToSeconds(tick) {
    const index = binarySearchLast(this.tempoMap, tick, (item) => item.tick);
    const tempo = this.tempoMap[Math.max(0, index)] || { tick: 0, seconds: 0, microsecondsPerBeat: 500_000 };
    return tempo.seconds + (tick - tempo.tick) * tempo.microsecondsPerBeat / this.ticksPerBeat / 1_000_000;
  }

  secondsToTick(seconds) {
    const index = binarySearchLast(this.tempoMap, seconds, (item) => item.seconds);
    const tempo = this.tempoMap[Math.max(0, index)] || { tick: 0, seconds: 0, microsecondsPerBeat: 500_000 };
    return Math.max(0, Math.round(tempo.tick + (seconds - tempo.seconds) * this.ticksPerBeat * 1_000_000 / tempo.microsecondsPerBeat));
  }

  tempoAt(seconds) {
    const index = binarySearchLast(this.tempoMap, seconds, (item) => item.seconds);
    return this.tempoMap[Math.max(0, index)]?.bpm || 120;
  }

  signatureAt(seconds) {
    const index = binarySearchLast(this.timeSignatures, seconds, (item) => item.seconds);
    return this.timeSignatures[Math.max(0, index)] || { numerator: 4, denominator: 4 };
  }

  keyAt(seconds) {
    const index = binarySearchLast(this.keySignatures, seconds, (item) => item.seconds);
    return this.keySignatures[index] || null;
  }

  notesInRange(start, end, hardLimit = 20_000) {
    const lookback = Math.max(0, start - 30);
    let index = binarySearchLast(this.notes, lookback, (note) => note.start);
    index = Math.max(0, index);
    const result = [];
    for (; index < this.notes.length; index += 1) {
      const note = this.notes[index];
      if (note.start > end) break;
      if (note.end >= start) result.push(note);
      if (result.length >= hardLimit) break;
    }
    return result;
  }

  lyricAt(seconds) {
    if (!this.lyrics.length) return { previous: null, current: null, next: null, index: -1 };
    const index = binarySearchLast(this.lyrics, seconds, (item) => item.time);
    return {
      previous: this.lyrics[index - 1] || null,
      current: this.lyrics[Math.max(0, index)] || null,
      next: this.lyrics[Math.max(0, index) + 1] || null,
      index
    };
  }

  eventWindow(seconds, radius = 40) {
    const center = Math.max(0, binarySearchLast(this.events, seconds, (item) => item.time));
    return this.events.slice(Math.max(0, center - radius), center + radius + 1);
  }

  get stats() {
    return {
      format: this.format,
      tracks: this.tracks.length,
      channels: new Set(this.tracks.flatMap((track) => track.channels)).size,
      notes: this.notes.length,
      events: this.eventCount,
      duration: this.duration,
      tempos: this.tempoMap.length,
      lyrics: this.lyrics.length,
      markers: this.markers.length,
      isBlackMIDI: this.notes.length > 250_000 || this.eventCount > 1_000_000
    };
  }
}

export function keySignatureName(key, scale) {
  const major = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
  const minor = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
  const index = Math.max(0, Math.min(14, Number(key) + 7));
  return `${scale ? minor[index] : major[index]} ${scale ? 'minor' : 'major'}`;
}

export function estimateKey(notes) {
  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const histogram = new Array(12).fill(0);
  for (const note of notes) histogram[note.pitch % 12] += Math.max(0.05, note.duration) * (0.25 + note.velocity / 127);
  let best = { score: -Infinity, root: 0, minor: false };
  for (let root = 0; root < 12; root += 1) {
    for (const minor of [false, true]) {
      const profile = minor ? minorProfile : majorProfile;
      const score = histogram.reduce((sum, value, pitch) => sum + value * profile[(pitch - root + 12) % 12], 0);
      if (score > best.score) best = { score, root, minor };
    }
  }
  const names = best.root > 5 && best.root !== 7 && best.root !== 9 && best.root !== 11 ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return { ...best, name: `${names[best.root]} ${best.minor ? 'minor' : 'major'}` };
}
