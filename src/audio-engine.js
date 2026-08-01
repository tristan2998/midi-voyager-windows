import { WorkletSynthesizer, Sequencer, audioBufferToWav } from 'spessasynth_lib';
import { BasicMIDI, MIDIControllers, MIDIMessage, MIDIMessageTypes } from 'spessasynth_core';
import { clamp } from './constants.js';

const LOAD_TIMEOUT_MS = 20_000;

export class AudioEngine extends EventTarget {
  constructor(options = {}) {
    super();
    this.workletUrl = options.workletUrl || './assets/spessasynth_processor.min.js';
    this.defaultSoundFontUrl = options.defaultSoundFontUrl || './assets/GeneralUser.sf2';
    this.context = null;
    this.synth = null;
    this.sequencer = null;
    this.masterGain = null;
    this.analyser = null;
    this.initializing = null;
    this.midiBuffer = null;
    this.midiName = '';
    this.basicMIDI = null;
    this.soundBanks = new Map();
    this.bankOrder = [];
    this.channelState = Array.from({ length: 16 }, () => ({
      muted: false, solo: false, volume: 1, pan: 0, transpose: 0, program: null, lockedProgram: false
    }));
    this.globalTranspose = 0;
    this.masterVolume = 0.82;
    this.rate = 1;
    this.loop = { enabled: false, start: 0, end: 0 };
    this.metronomeEnabled = false;
    this.lastMetronomeBeat = -1;
    this.activeNotes = Array.from({ length: 16 }, () => new Set());
    this.midiAccess = null;
    this.midiInput = null;
    this.midiOutput = null;
    this.outputOnly = false;
  }

  async ensureReady() {
    if (this.synth) return;
    if (this.initializing) return this.initializing;
    this.initializing = this._initialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async _initialize() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('This Windows WebView does not provide Web Audio. Install/update Microsoft Edge WebView2.');
    this.context = new Context({ latencyHint: 'playback' });
    await this.context.audioWorklet.addModule(this.workletUrl);
    this.synth = new WorkletSynthesizer(this.context, { eventsEnabled: true });
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.masterVolume;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.78;
    this.synth.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.context.destination);

    const response = await fetch(this.defaultSoundFontUrl);
    if (!response.ok) throw new Error(`Could not load the bundled SoundFont (${response.status}).`);
    const defaultBank = await response.arrayBuffer();
    this.soundBanks.set('default', {
      id: 'default', name: 'GeneralUser GS', buffer: defaultBank.slice(0), bankOffset: 0, builtIn: true, enabled: true
    });
    this.bankOrder = ['default'];
    await this.synth.soundBankManager.addSoundBank(defaultBank.slice(0), 'default', 0);
    await this.synth.isReady;

    this.sequencer = new Sequencer(this.synth, { skipToFirstNoteOn: false, initialPlaybackRate: this.rate });
    this._bindEvents();
    this.dispatchEvent(new CustomEvent('ready'));
  }

  _bindEvents() {
    this.sequencer.eventHandler.addEvent('songChange', 'voyager-song', (midiData) => {
      this.lastMetronomeBeat = -1;
      this.applyChannelState();
      this.dispatchEvent(new CustomEvent('songchange', { detail: midiData }));
    });
    this.sequencer.eventHandler.addEvent('songEnded', 'voyager-ended', () => {
      this.dispatchEvent(new CustomEvent('ended'));
    });
    this.sequencer.eventHandler.addEvent('textEvent', 'voyager-text', (detail) => {
      this.dispatchEvent(new CustomEvent('textevent', { detail }));
    });
    this.synth.eventHandler.addEvent('noteOn', 'voyager-note-on', ({ channel, midiNote, velocity }) => {
      this.activeNotes[channel]?.add(midiNote);
      this.dispatchEvent(new CustomEvent('noteon', { detail: { channel, midiNote, velocity } }));
    });
    this.synth.eventHandler.addEvent('noteOff', 'voyager-note-off', ({ channel, midiNote }) => {
      this.activeNotes[channel]?.delete(midiNote);
      this.dispatchEvent(new CustomEvent('noteoff', { detail: { channel, midiNote } }));
    });
    this.synth.eventHandler.addEvent('stopAll', 'voyager-stop-all', ({ channel }) => {
      this.activeNotes[channel]?.clear();
    });
    this.synth.eventHandler.addEvent('programChange', 'voyager-program', (detail) => {
      this.dispatchEvent(new CustomEvent('programchange', { detail }));
    });
  }

  async loadMIDI(arrayBuffer, fileName) {
    await this.ensureReady();
    this.pause();
    this.midiBuffer = arrayBuffer.slice(0);
    this.midiName = fileName;
    this.basicMIDI = BasicMIDI.fromArrayBuffer(arrayBuffer.slice(0), fileName);
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MIDI loading timed out. The file may be damaged or unusually large.')), LOAD_TIMEOUT_MS);
      const onChange = (event) => {
        clearTimeout(timeout);
        this.removeEventListener('songchange', onChange);
        resolve(event.detail);
      };
      this.addEventListener('songchange', onChange);
    });
    this.sequencer.loadNewSongList([{ binary: arrayBuffer.slice(0), fileName }]);
    await loaded;
    this.rate = 1;
    this.sequencer.playbackRate = 1;
    this.applyChannelState();
    return this.basicMIDI;
  }

  async resumeContext() {
    await this.ensureReady();
    if (this.context.state !== 'running') await this.context.resume();
  }

  async play(countIn = 0, bpm = 120) {
    if (!this.midiBuffer) return;
    await this.resumeContext();
    if (countIn > 0 && this.sequencer.paused) {
      const beatLength = 60 / Math.max(20, bpm);
      const startAt = this.context.currentTime + 0.04;
      for (let index = 0; index < countIn; index += 1) this._beep(startAt + index * beatLength, index === 0);
      await new Promise((resolve) => setTimeout(resolve, countIn * beatLength * 1000));
    }
    this.sequencer.play();
    this.dispatchEvent(new CustomEvent('playstate', { detail: { playing: true } }));
  }

  pause() {
    if (!this.sequencer) return;
    this.sequencer.pause();
    this.dispatchEvent(new CustomEvent('playstate', { detail: { playing: false } }));
  }

  stop() {
    if (!this.sequencer) return;
    this.sequencer.pause();
    this.sequencer.currentTime = 0;
    this.synth?.stopAll(true);
    this.activeNotes.forEach((set) => set.clear());
    this.dispatchEvent(new CustomEvent('playstate', { detail: { playing: false } }));
  }

  get paused() {
    return this.sequencer?.paused ?? true;
  }

  get currentTime() {
    if (!this.sequencer?.midiData) return 0;
    return Math.max(0, this.sequencer.currentHighResolutionTime || this.sequencer.currentTime || 0);
  }

  get duration() {
    return this.sequencer?.duration || this.basicMIDI?.duration || 0;
  }

  seek(seconds) {
    if (!this.sequencer?.midiData) return;
    this.sequencer.currentTime = clamp(seconds, 0, this.duration || seconds);
    this.lastMetronomeBeat = -1;
    window.setTimeout(() => this.applyChannelState(), 0);
  }

  setRate(rate) {
    this.rate = clamp(Number(rate) || 1, 0.1, 4);
    if (this.sequencer) this.sequencer.playbackRate = this.rate;
  }

  setMasterVolume(volume) {
    this.masterVolume = clamp(Number(volume) || 0, 0, 1.5);
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.015);
  }

  setGlobalTranspose(semitones) {
    this.globalTranspose = clamp(Math.round(Number(semitones) || 0), -48, 48);
    this.applyChannelState();
  }

  setLoop(enabled, start, end) {
    this.loop = {
      enabled: Boolean(enabled),
      start: Math.max(0, Number(start) || 0),
      end: Math.max(0, Number(end) || this.duration)
    };
  }

  updateLoop() {
    if (!this.loop.enabled || this.loop.end <= this.loop.start || this.paused) return;
    if (this.currentTime >= this.loop.end) this.seek(this.loop.start);
  }

  setChannelState(channel, patch) {
    if (!this.channelState[channel]) return;
    Object.assign(this.channelState[channel], patch);
    this.applyChannelState();
  }

  applyChannelState() {
    if (!this.synth) return;
    const anySolo = this.channelState.some((state) => state.solo);
    for (let channel = 0; channel < this.synth.midiChannels.length; channel += 1) {
      const state = this.channelState[channel] || this.channelState[channel % 16];
      const midiChannel = this.synth.midiChannels[channel];
      const muted = state.muted || (anySolo && !state.solo);
      midiChannel.setSystemParameter('isMuted', muted);
      midiChannel.setSystemParameter('gain', clamp(state.volume, 0, 2));
      midiChannel.setSystemParameter('pan', clamp(state.pan, -1, 1));
      midiChannel.setSystemParameter('keyShift', clamp(this.globalTranspose + state.transpose, -96, 96));
      midiChannel.setSystemParameter('presetLock', Boolean(state.lockedProgram));
      if (state.program !== null && state.lockedProgram) this.synth.programChange(channel, state.program);
    }
  }

  _orderedSoundBanks() {
    return this.bankOrder.map((id) => this.soundBanks.get(id)).filter(Boolean);
  }

  _enabledBankIds() {
    return this._orderedSoundBanks().filter((bank) => bank.enabled).map((bank) => bank.id);
  }

  _syncSoundBankPriority() {
    const enabledIds = this._enabledBankIds();
    if (enabledIds.length && this.synth?.soundBankManager) this.synth.soundBankManager.priorityOrder = enabledIds;
  }

  async addSoundBank(arrayBuffer, name, bankOffset = 0, sourcePath = null, options = {}) {
    await this.ensureReady();
    const id = options.id || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      id,
      name,
      buffer: arrayBuffer.slice(0),
      bankOffset: Number(bankOffset) || 0,
      builtIn: false,
      sourcePath,
      enabled: options.enabled !== false
    };
    this.soundBanks.set(id, entry);
    this.bankOrder = this.bankOrder.filter((item) => item !== id);
    if (options.position === 'bottom') this.bankOrder.push(id);
    else if (Number.isInteger(options.position)) this.bankOrder.splice(clamp(options.position, 0, this.bankOrder.length), 0, id);
    else this.bankOrder.unshift(id);
    if (entry.enabled) await this.synth.soundBankManager.addSoundBank(arrayBuffer.slice(0), id, entry.bankOffset);
    this._syncSoundBankPriority();
    this.dispatchEvent(new CustomEvent('soundbankschange'));
    return id;
  }

  setSoundBankOrder(ids) {
    const requested = [...new Set((ids || []).filter((id) => this.soundBanks.has(id)))];
    this.bankOrder = [...requested, ...this.bankOrder.filter((id) => !requested.includes(id) && this.soundBanks.has(id))];
    this._syncSoundBankPriority();
    this.dispatchEvent(new CustomEvent('soundbankschange'));
    return [...this.bankOrder];
  }

  async setSoundBankEnabled(id, enabled) {
    await this.ensureReady();
    const entry = this.soundBanks.get(id);
    if (!entry) throw new Error('That SoundFont is no longer loaded.');
    const nextEnabled = Boolean(enabled);
    if (entry.enabled === nextEnabled) return;
    if (!nextEnabled && this._enabledBankIds().length <= 1) {
      throw new Error('At least one SoundFont must remain enabled.');
    }
    if (nextEnabled) {
      await this.synth.soundBankManager.addSoundBank(entry.buffer.slice(0), id, entry.bankOffset);
      entry.enabled = true;
    } else {
      await this.synth.soundBankManager.deleteSoundBank(id);
      entry.enabled = false;
    }
    this._syncSoundBankPriority();
    this.applyChannelState();
    this.dispatchEvent(new CustomEvent('soundbankschange'));
  }

  async removeSoundBank(id) {
    if (id === 'default' || !this.soundBanks.has(id)) return;
    const entry = this.soundBanks.get(id);
    if (entry.enabled && this._enabledBankIds().length <= 1) {
      const fallback = this.soundBanks.get('default');
      if (fallback && !fallback.enabled) {
        await this.synth.soundBankManager.addSoundBank(fallback.buffer.slice(0), fallback.id, fallback.bankOffset);
        fallback.enabled = true;
      }
    }
    if (entry.enabled) await this.synth.soundBankManager.deleteSoundBank(id);
    this.soundBanks.delete(id);
    this.bankOrder = this.bankOrder.filter((item) => item !== id);
    this._syncSoundBankPriority();
    this.dispatchEvent(new CustomEvent('soundbankschange'));
  }

  getSoundBanks() {
    let activePriority = 0;
    return this._orderedSoundBanks().map(({ buffer, ...item }) => ({
      ...item,
      size: buffer.byteLength,
      priority: item.enabled ? ++activePriority : null
    }));
  }

  setMetronome(enabled) {
    this.metronomeEnabled = Boolean(enabled);
    this.lastMetronomeBeat = -1;
  }

  tickMetronome(model) {
    if (!this.metronomeEnabled || !this.context || this.paused || !model) return;
    const time = this.currentTime;
    const tick = model.secondsToTick(time);
    const signature = model.signatureAt(time);
    const beatTicks = model.ticksPerBeat * 4 / Math.max(1, signature.denominator);
    const beat = Math.floor(tick / beatTicks);
    if (beat === this.lastMetronomeBeat) return;
    this.lastMetronomeBeat = beat;
    this._beep(this.context.currentTime + 0.01, beat % signature.numerator === 0);
  }

  _beep(atTime, accent = false) {
    if (!this.context) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(accent ? 1320 : 880, atTime);
    gain.gain.setValueAtTime(0.0001, atTime);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.17 : 0.10, atTime + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.055);
    oscillator.connect(gain).connect(this.masterGain || this.context.destination);
    oscillator.start(atTime);
    oscillator.stop(atTime + 0.065);
  }

  noteOn(channel, note, velocity = 100) {
    this.resumeContext().then(() => this.synth.noteOn(channel, note, velocity));
  }

  noteOff(channel, note) {
    this.synth?.noteOff(channel, note);
  }

  getSpectrum(target = new Uint8Array(256)) {
    if (!this.analyser) return target.fill(0);
    this.analyser.getByteFrequencyData(target);
    return target;
  }

  async initializeMIDIDevices() {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is unavailable. Update Microsoft Edge WebView2.');
    this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    this.midiAccess.onstatechange = () => this.dispatchEvent(new CustomEvent('midideviceschange'));
    return this.getMIDIDevices();
  }

  getMIDIDevices() {
    if (!this.midiAccess) return { inputs: [], outputs: [] };
    const shape = (port) => ({ id: port.id, name: port.name || 'Unnamed device', manufacturer: port.manufacturer || '' });
    return {
      inputs: [...this.midiAccess.inputs.values()].map(shape),
      outputs: [...this.midiAccess.outputs.values()].map(shape)
    };
  }

  selectMIDIInput(id) {
    if (this.midiInput) this.midiInput.onmidimessage = null;
    this.midiInput = id && this.midiAccess ? this.midiAccess.inputs.get(id) : null;
    if (this.midiInput) {
      this.midiInput.onmidimessage = (event) => {
        this.resumeContext().then(() => this.synth.sendMessage(event.data));
        this.dispatchEvent(new CustomEvent('midiinput', { detail: [...event.data] }));
      };
    }
  }

  selectMIDIOutput(id, outputOnly = true) {
    this.midiOutput = id && this.midiAccess ? this.midiAccess.outputs.get(id) : null;
    this.outputOnly = Boolean(outputOnly && this.midiOutput);
    if (this.sequencer) {
      if (this.outputOnly) this.sequencer.connectMIDIOutput({ send: (data) => this.midiOutput?.send(data) });
      else this.sequencer.connectMIDIOutput(undefined);
    }
  }

  createModifiedMIDI(markers = []) {
    if (!this.midiBuffer) throw new Error('No MIDI file is loaded.');
    const midi = BasicMIDI.fromArrayBuffer(this.midiBuffer.slice(0), this.midiName);
    const channels = new Map();
    this.channelState.forEach((state, channel) => {
      const controllers = new Map();
      controllers.set(MIDIControllers.mainVolume, Math.round(clamp(state.volume, 0, 1) * 127));
      controllers.set(MIDIControllers.pan, Math.round((clamp(state.pan, -1, 1) + 1) * 63.5));
      const modification = {
        controllers,
        keyShift: this.globalTranspose + state.transpose
      };
      if (state.program !== null && state.lockedProgram) {
        modification.patch = { program: state.program, bankMSB: 0, bankLSB: 0, isGMGSDrum: channel === 9 };
      }
      channels.set(channel, modification);
    });
    midi.modify({ channels });

    if (markers.length && midi.tracks.length) {
      const target = midi.tracks[0];
      for (const marker of markers) {
        if (marker.source === 'file') continue;
        const ticks = midi.secondsToMIDITicks(marker.time);
        target.pushEvent(new MIDIMessage(ticks, MIDIMessageTypes.marker, new TextEncoder().encode(marker.name || 'Marker')));
        if (Number.isInteger(marker.program)) {
          target.pushEvent(MIDIMessage.programChange(ticks, marker.channel || 0, marker.program));
        }
      }
      midi.flush(true);
    }
    return midi;
  }

  exportMIDI(markers = []) {
    return this.createModifiedMIDI(markers).writeMIDI();
  }

  async renderWAV(markers = [], progressCallback = () => {}) {
    await this.ensureReady();
    const midi = this.createModifiedMIDI(markers);
    const sampleRate = 44_100;
    const seconds = Math.max(1, midi.duration / this.rate + 2.5);
    const frames = Math.ceil(seconds * sampleRate);
    const offline = new OfflineAudioContext(2, frames, sampleRate);
    await offline.audioWorklet.addModule(this.workletUrl);
    const renderer = new WorkletSynthesizer(offline, { eventsEnabled: false });
    renderer.connect(offline.destination);
    progressCallback(0.05);
    await renderer.startOfflineRender({
      midiSequence: midi,
      loopCount: 0,
      soundBankList: this._orderedSoundBanks().filter((bank) => bank.enabled).map((bank) => ({
        bankOffset: bank.bankOffset,
        soundBankBuffer: bank.buffer.slice(0)
      })),
      sequencerOptions: { skipToFirstNoteOn: false, initialPlaybackRate: this.rate }
    });
    progressCallback(0.15);
    const rendered = await offline.startRendering();
    progressCallback(0.95);
    const blob = audioBufferToWav(rendered, {
      metadata: { title: this.midiName.replace(/\.(mid|midi|kar)$/i, ''), artist: '', album: '', genre: '' }
    });
    progressCallback(1);
    renderer.destroy();
    return blob;
  }

  destroy() {
    this.pause();
    this.synth?.destroy();
    this.context?.close();
  }
}
