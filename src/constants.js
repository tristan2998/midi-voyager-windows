export const APP_NAME = 'MIDI Voyager Windows';

export const GM_PROGRAMS = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2',
  'Synth Bass 1', 'Synth Bass 2', 'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings',
  'Orchestral Harp', 'Timpani', 'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit', 'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2', 'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet', 'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi',
  'Whistle', 'Ocarina', 'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)',
  'Pad 7 (halo)', 'Pad 8 (sweep)', 'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)', 'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag Pipe', 'Fiddle', 'Shanai', 'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum',
  'Melodic Tom', 'Synth Drum', 'Reverse Cymbal', 'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
];

export const CHANNEL_COLORS = [
  '#58e6ff', '#ff5ac8', '#ffc857', '#7ef29a', '#9d82ff', '#ff765f', '#69b9ff', '#d6f36b',
  '#ff9a5c', '#d76cff', '#53e3c2', '#ff5f7a', '#84a7ff', '#e9e45c', '#b2f07a', '#f28fd5'
];

export const PITCH_CLASS_COLORS = [
  '#ff5e78', '#ff865e', '#ffbd5e', '#e9e75e', '#9ce768', '#58dda3',
  '#52d7dc', '#5fa6ff', '#7c77ff', '#aa6df2', '#de68e4', '#f05fa7'
];

export const NOTE_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export const VIEW_MODES = [
  { id: 'waterfall', label: 'Waterfall', icon: '▥' },
  { id: 'roll', label: 'Piano roll', icon: '▤' },
  { id: 'staff', label: 'Staff', icon: '𝄞' },
  { id: 'spectrum', label: 'Spectrum', icon: '▥' },
  { id: 'karaoke', label: 'Karaoke', icon: 'Aa' },
  { id: 'events', label: 'Events', icon: '≡' }
];

export const PERSPECTIVES = {
  performance: {
    name: 'Performance', view: 'waterfall', sidebar: true, bottomPanel: 'mixer', compactHeader: false
  },
  karaoke: {
    name: 'Karaoke', view: 'karaoke', sidebar: false, bottomPanel: 'lyrics', compactHeader: true
  },
  studio: {
    name: 'Studio', view: 'roll', sidebar: true, bottomPanel: 'mixer', compactHeader: false
  },
  analysis: {
    name: 'Analysis', view: 'staff', sidebar: true, bottomPanel: 'chords', compactHeader: false
  },
  spectrum: {
    name: 'Winamp Spectrum', view: 'spectrum', sidebar: false, bottomPanel: 'mixer', compactHeader: true
  }
};

export const DEFAULT_CHANNEL_STATE = () => ({
  muted: false,
  solo: false,
  volume: 1,
  pan: 0,
  transpose: 0,
  program: null,
  lockedProgram: false
});

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function midiNoteName(note, preferFlats = false) {
  const names = preferFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return `${names[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}
