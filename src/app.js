import { writeMidi } from 'midi-file';
import { BasicMIDI } from 'spessasynth_core';
import { AudioEngine } from './audio-engine.js';
import { MIDIModel } from './midi-model.js';
import { analyzeChords, chordAt } from './chords.js';
import {
  APP_NAME,
  DEFAULT_CHANNEL_STATE,
  GM_PROGRAMS,
  PERSPECTIVES,
  VIEW_MODES,
  clamp,
  formatTime
} from './constants.js';
import { Visualizer, mixerSliderColor } from './visualizer.js';
import { visualizerScrollSeconds, visualizerZoomMultiplier } from './visualizer-interaction.js';
import { AppStore } from './storage.js';
import { readDescriptor } from './file-reader.js';
import { inspectMIDI, repairMIDI } from './midi-repair.js';
import {
  moveSoundBank,
  resolveSavedSoundBankOrder,
  soundFontStorageKey
} from './soundfont-stack.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const store = new AppStore();
const engine = new AudioEngine({
  workletUrl: './assets/spessasynth_processor.min.js',
  defaultSoundFontUrl: './assets/GeneralUser.sf2'
});
const visualizer = new Visualizer($('#visualizer'), $('#visual-overlay'));

const state = {
  file: null,
  model: null,
  analysis: null,
  markers: [],
  loop: { enabled: false, start: 0, end: 0 },
  channelSettings: Array.from({ length: 16 }, DEFAULT_CHANNEL_STATE),
  rate: 1,
  transpose: 0,
  queue: [],
  queueIndex: -1,
  selectedPlaylist: 'favourites',
  perspective: store.settings.lastPerspective || 'performance',
  view: store.settings.view || 'waterfall',
  dirtyVisual: true,
  seeking: false,
  pressedPianoNote: null,
  maxTempo: Number(store.settings.maxTempo) || 4,
  repairReport: null
};
let persistedSoundFontsRestored = false;
let draggedSoundFontId = null;
let expandedSoundFontId = null;
let incomingFileQueue = Promise.resolve();
let pendingWheelSeek = null;
let wheelSeekFrame = 0;
const spectrumBuffer = new Uint8Array(256);
const waveformBuffer = new Uint8Array(512);

function toast(title, message = '', type = '') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  const strong = document.createElement('strong');
  strong.textContent = title;
  item.append(strong);
  if (message) {
    const span = document.createElement('span');
    span.textContent = message;
    item.append(span);
  }
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), type === 'error' ? 7000 : 3600);
}

function setBusy(busy, label = 'Loading…') {
  document.body.classList.toggle('busy', busy);
  $('#open-midi').disabled = busy;
  $('#file-subtitle').textContent = busy ? label : (state.model ? subtitleForModel(state.model) : 'Drop .mid, .midi, .kar, .rmi or .xmf anywhere');
}

function subtitleForModel(model) {
  const stats = model.stats;
  return `Format ${stats.format} · ${stats.tracks} tracks · ${stats.notes.toLocaleString()} notes · ${formatTime(stats.duration)}`;
}

function friendlyError(error) {
  console.error(error);
  toast('Something went wrong', error?.message || String(error), 'error');
}

async function loadDescriptor(descriptor, options = {}) {
  const extension = descriptor.name.split('.').pop().toLowerCase();
  if (['sf2', 'sf3', 'dls', 'sf2pack'].includes(extension)) {
    return loadSoundFontDescriptor(descriptor);
  }
  setBusy(true, `Reading ${descriptor.name}…`);
  try {
    const buffer = options.buffer || await readDescriptor(descriptor, window.native, {
      onProgress: ({ loaded, total }) => {
        if (total > 2 * 1024 * 1024) setBusy(true, `Reading ${descriptor.name}… ${Math.round(loaded / total * 100)}%`);
      }
    });
    await nextFrame();
    const visualBuffer = ['rmi', 'rmid', 'xmf'].includes(extension)
      ? BasicMIDI.fromArrayBuffer(buffer.slice(0), descriptor.name).writeMIDI()
      : buffer;
    const model = new MIDIModel(visualBuffer, descriptor.name);
    setBusy(true, `Starting the SoundFont engine…`);
    await engine.ensureReady();
    await restorePersistedSoundFonts();
    await engine.loadMIDI(buffer, descriptor.name);
    state.file = { ...descriptor, size: descriptor.size || buffer.byteLength };
    state.model = model;
    state.analysis = null;
    state.repairReport = null;
    state.markers = model.markers.map((marker) => ({ ...marker }));
    state.channelSettings = Array.from({ length: 16 }, DEFAULT_CHANNEL_STATE);
    initializeChannelsFromModel(model);
    restoreFileSettings();
    engine.channelState = state.channelSettings;
    engine.setRate(state.rate);
    engine.setGlobalTranspose(state.transpose);
    engine.setLoop(state.loop.enabled, state.loop.start, state.loop.end);
    engine.applyChannelState();
    visualizer.channelState = state.channelSettings;
    visualizer.setModel(model);
    visualizer.setAnalysis(null);
    $('#file-title').textContent = descriptor.name;
    $('#file-subtitle').textContent = subtitleForModel(model);
    $('#seek').max = String(Math.max(0.001, model.duration));
    $('#duration-time').textContent = formatTime(model.duration);
    store.rememberFile(state.file);
    renderAllFileUI();
    setBusy(false);
    toast('MIDI ready', `${model.stats.notes.toLocaleString()} notes across ${model.stats.tracks} tracks`, 'success');
    setTimeout(() => {
      try {
        state.analysis = analyzeChords(model);
        visualizer.setAnalysis(state.analysis);
        renderChords();
        renderInfo();
        state.dirtyVisual = true;
      } catch (error) {
        console.warn('Chord analysis failed', error);
      }
    }, 20);
    return model;
  } catch (error) {
    setBusy(false);
    friendlyError(error);
    return null;
  }
}

function initializeChannelsFromModel(model) {
  for (const track of model.tracks) {
    for (const channel of track.channels) {
      if (state.channelSettings[channel].program === null && track.program !== null) {
        state.channelSettings[channel].program = track.program;
      }
    }
  }
}

function restoreFileSettings() {
  const saved = store.getFileSettings(state.file);
  if (!saved) {
    state.rate = 1;
    state.transpose = 0;
    state.loop = { enabled: false, start: 0, end: state.model.duration };
    return;
  }
  state.rate = clamp(Number(saved.rate) || 1, 0.1, state.maxTempo);
  state.transpose = clamp(Number(saved.transpose) || 0, -48, 48);
  if (Array.isArray(saved.channels)) {
    saved.channels.slice(0, 16).forEach((channel, index) => Object.assign(state.channelSettings[index], channel));
  }
  if (Array.isArray(saved.markers)) {
    const fileMarkers = state.markers.filter((marker) => marker.source === 'file');
    const userMarkers = saved.markers.filter((marker) => marker.source !== 'file');
    state.markers = [...fileMarkers, ...userMarkers].sort((a, b) => a.time - b.time);
  }
  if (saved.loop) state.loop = { ...state.loop, ...saved.loop };
}

function saveFileSettings() {
  if (!state.file) return;
  store.saveFileSettings(state.file, {
    rate: state.rate,
    transpose: state.transpose,
    channels: state.channelSettings,
    markers: state.markers,
    loop: state.loop
  });
}

function renderAllFileUI() {
  renderMixer();
  renderLyrics();
  renderMarkers();
  renderInfo();
  renderRecents();
  renderPlaylists();
  updateTransportLabels();
  updateStatus(0);
  state.dirtyVisual = true;
}

async function openMidiFiles(multiple = false) {
  try {
    if (window.native?.openMidiFiles) {
      const files = await window.native.openMidiFiles(Boolean(multiple));
      if (!files?.length) return;
      state.queue = files;
      state.queueIndex = 0;
      await loadDescriptor(files[0]);
      return;
    }
    $('#midi-file-input').multiple = Boolean(multiple);
    $('#midi-file-input').click();
  } catch (error) {
    friendlyError(error);
  }
}

async function loadSoundFontDescriptor(descriptor) {
  try {
    setBusy(true, `Loading SoundFont ${descriptor.name}…`);
    const buffer = await readDescriptor(descriptor, window.native, {
      onProgress: ({ loaded, total }) => {
        if (total > 2 * 1024 * 1024) setBusy(true, `Loading SoundFont ${descriptor.name}… ${Math.round(loaded / total * 100)}%`);
      }
    });
    await engine.ensureReady();
    await restorePersistedSoundFonts();
    await engine.addSoundBank(buffer, descriptor.name, 0, descriptor.path || null);
    persistSoundFontStack();
    renderSoundFonts();
    setBusy(false);
    toast('SoundFont loaded', descriptor.name, 'success');
  } catch (error) {
    setBusy(false);
    friendlyError(error);
  }
}

function persistSoundFontStack() {
  const banks = engine.getSoundBanks();
  const persistentBanks = banks.filter((bank) => bank.builtIn || bank.sourcePath);
  const defaultBank = banks.find((bank) => bank.builtIn);
  store.updateSettings({
    soundFonts: banks
      .filter((bank) => !bank.builtIn && bank.sourcePath)
      .map((bank) => ({
        name: bank.name,
        path: bank.sourcePath,
        enabled: bank.enabled !== false,
        bankOffset: bank.bankOffset || 0
      })),
    soundFontOrder: persistentBanks.map(soundFontStorageKey),
    defaultSoundFontEnabled: defaultBank?.enabled !== false,
    defaultSoundFontOffset: defaultBank?.bankOffset || 0
  });
}

async function restorePersistedSoundFonts() {
  if (persistedSoundFontsRestored || !window.native?.openKnownFile) return;
  persistedSoundFontsRestored = true;
  const savedFonts = Array.isArray(store.settings.soundFonts) ? store.settings.soundFonts : [];
  for (const saved of savedFonts) {
    try {
      const descriptor = await window.native.openKnownFile(saved.path);
      const buffer = await readDescriptor(descriptor);
      await engine.addSoundBank(buffer, saved.name || descriptor.name, saved.bankOffset || 0, saved.path, {
        enabled: saved.enabled !== false,
        position: 'bottom'
      });
    } catch (error) {
      console.warn(`Could not restore SoundFont ${saved.name || saved.path}`, error);
    }
  }
  engine.setSoundBankOrder(resolveSavedSoundBankOrder(
    engine.getSoundBanks(),
    store.settings.soundFontOrder,
    savedFonts
  ));
  if (store.settings.defaultSoundFontOffset) {
    try { await engine.setSoundBankOffset('default', store.settings.defaultSoundFontOffset); }
    catch (error) { console.warn('Could not restore the bundled SoundFont bank offset.', error); }
  }
  if (store.settings.defaultSoundFontEnabled === false) {
    try { await engine.setSoundBankEnabled('default', false); }
    catch (error) { console.warn('The bundled fallback SoundFont had to remain enabled.', error); }
  }
}

function descriptorsFromFileList(files) {
  return [...files].map((file) => ({ name: file.name, size: file.size, file, path: null }));
}

function updateTransportLabels() {
  $('#tempo-value').textContent = `${Math.round(state.rate * 100)}%`;
  $('#pitch-value').textContent = state.transpose > 0 ? `+${state.transpose}` : String(state.transpose);
  $('#master-volume').value = String(engine.masterVolume);
  $('#loop-button').classList.toggle('active', state.loop.enabled);
  $('#metronome-button').classList.toggle('active', engine.metronomeEnabled);
  $('#loop-start-label').textContent = formatTime(state.loop.start);
  $('#loop-end-label').textContent = formatTime(state.loop.end);
}

function setRate(rate) {
  state.rate = clamp(rate, 0.1, state.maxTempo);
  engine.setRate(state.rate);
  updateTransportLabels();
  saveFileSettings();
}

function setTranspose(semitones) {
  state.transpose = clamp(Math.round(semitones), -48, 48);
  engine.setGlobalTranspose(state.transpose);
  updateTransportLabels();
  saveFileSettings();
  state.dirtyVisual = true;
}

function togglePlay() {
  if (!state.model) return toast('Open a MIDI file first');
  if (engine.paused) {
    const bpm = state.model.tempoAt(engine.currentTime) * state.rate;
    engine.play(Number(store.settings.countIn) || 0, bpm).catch(friendlyError);
  } else engine.pause();
}

function seekTo(seconds) {
  if (!state.model) return;
  engine.seek(clamp(seconds, 0, state.model.duration));
  state.dirtyVisual = true;
}

function queueWheelSeek(deltaSeconds) {
  if (!state.model || !Number.isFinite(deltaSeconds) || deltaSeconds === 0) return;
  const origin = pendingWheelSeek ?? engine.currentTime;
  pendingWheelSeek = clamp(origin + deltaSeconds, 0, state.model.duration);
  if (wheelSeekFrame) return;
  wheelSeekFrame = requestAnimationFrame(() => {
    const target = pendingWheelSeek;
    pendingWheelSeek = null;
    wheelSeekFrame = 0;
    if (target !== null) seekTo(target);
  });
}

function queueStep(offset) {
  if (!state.queue.length) return;
  const next = state.queueIndex + offset;
  if (next < 0 || next >= state.queue.length) return;
  state.queueIndex = next;
  loadDescriptor(state.queue[next]);
}

function renderViewSwitcher() {
  const root = $('#view-switcher');
  root.replaceChildren();
  for (const view of VIEW_MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.view = view.id;
    button.classList.toggle('active', state.view === view.id);
    const icon = document.createElement('i');
    icon.textContent = view.icon;
    const label = document.createElement('span');
    label.textContent = view.label;
    button.append(icon, label);
    button.addEventListener('click', () => setView(view.id));
    root.append(button);
  }
}

function setView(view) {
  state.view = view;
  store.updateSettings({ view });
  visualizer.setView(view);
  $$('#view-switcher button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  state.dirtyVisual = true;
}

function renderMixer() {
  const root = $('#mixer-list');
  root.replaceChildren();
  if (!state.model) {
    root.append(emptyNode('Mixer controls appear after a MIDI file is loaded.'));
    return;
  }
  const usedChannels = [...new Set(state.model.tracks.flatMap((track) => track.channels))].sort((a, b) => a - b);
  for (const channel of usedChannels) root.append(createMixerStrip(channel));
}

function createMixerStrip(channel) {
  const setting = state.channelSettings[channel];
  const tracks = state.model.tracks.filter((track) => track.channels.includes(channel));
  const name = channel === 9 ? 'Drum kit' : (tracks.map((track) => track.name).filter(Boolean).join(' / ') || `Channel ${channel + 1}`);
  const stripColor = mixerSliderColor(tracks, channel, visualizer.colorMode);
  const strip = document.createElement('div');
  strip.className = `mixer-strip ${setting.muted ? 'muted' : ''} ${setting.solo ? 'solo' : ''}`;
  strip.style.setProperty('--strip-color', stripColor);
  strip.dataset.channel = String(channel);

  const heading = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'mixer-title';
  title.title = name;
  title.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'mixer-channel';
  sub.textContent = `CH ${channel + 1}`;
  heading.append(title, sub);

  const body = document.createElement('div');
  body.className = 'mixer-body';
  const volume = document.createElement('input');
  volume.className = 'vertical-slider';
  volume.type = 'range';
  volume.min = '0'; volume.max = '1.5'; volume.step = '0.01'; volume.value = String(setting.volume);
  volume.title = `Channel volume ${Math.round(setting.volume * 100)}%`;
  const updateVolumeFill = () => {
    const percent = clamp(Number(volume.value) / Number(volume.max) * 100, 0, 100);
    volume.style.setProperty('--slider-fill', `${percent}%`);
  };
  updateVolumeFill();
  volume.addEventListener('input', () => {
    setting.volume = Number(volume.value);
    volume.title = `Channel volume ${Math.round(setting.volume * 100)}%`;
    updateVolumeFill();
    engine.setChannelState(channel, { volume: setting.volume });
    saveFileSettings();
  });
  const meter = document.createElement('div');
  meter.className = 'meter';
  meter.innerHTML = '<span></span>';
  meter.dataset.meterChannel = String(channel);
  body.append(volume, meter);

  const controls = document.createElement('div');
  controls.className = 'mixer-controls';
  const mute = document.createElement('button');
  mute.type = 'button'; mute.className = `mix-toggle mute ${setting.muted ? 'active' : ''}`; mute.textContent = 'MUTE';
  mute.addEventListener('click', () => {
    setting.muted = !setting.muted;
    engine.setChannelState(channel, { muted: setting.muted });
    renderMixer(); saveFileSettings(); state.dirtyVisual = true;
  });
  const solo = document.createElement('button');
  solo.type = 'button'; solo.className = `mix-toggle solo ${setting.solo ? 'active' : ''}`; solo.textContent = 'SOLO';
  solo.addEventListener('click', () => {
    setting.solo = !setting.solo;
    engine.setChannelState(channel, { solo: setting.solo });
    renderMixer(); saveFileSettings(); state.dirtyVisual = true;
  });
  const program = document.createElement('select');
  program.className = 'program-select';
  const defaultOption = document.createElement('option');
  defaultOption.value = '-1'; defaultOption.textContent = 'File instrument (unlocked)';
  program.append(defaultOption);
  GM_PROGRAMS.forEach((programName, index) => {
    const option = document.createElement('option');
    option.value = String(index); option.textContent = `${index + 1}. ${programName}`;
    program.append(option);
  });
  program.value = setting.lockedProgram && setting.program !== null ? String(setting.program) : '-1';
  program.addEventListener('change', () => {
    const value = Number(program.value);
    setting.lockedProgram = value >= 0;
    if (value >= 0) setting.program = value;
    engine.setChannelState(channel, { program: setting.program, lockedProgram: setting.lockedProgram });
    saveFileSettings();
  });
  const pan = document.createElement('label');
  pan.className = 'pan-control';
  const panLabel = document.createElement('span');
  panLabel.textContent = 'PAN';
  const panInput = document.createElement('input');
  panInput.type = 'range'; panInput.min = '-1'; panInput.max = '1'; panInput.step = '0.01'; panInput.value = String(setting.pan);
  panInput.addEventListener('input', () => {
    setting.pan = Number(panInput.value);
    engine.setChannelState(channel, { pan: setting.pan });
    saveFileSettings();
  });
  pan.append(panLabel, panInput);
  controls.append(mute, solo, program, pan);
  strip.append(heading, body, controls);
  return strip;
}

function renderChords() {
  const root = $('#chord-strip');
  root.replaceChildren();
  if (!state.analysis?.segments?.length) {
    root.append(emptyNode(state.model ? 'Analysing chords…' : 'Chord analysis appears after loading a file.'));
    return;
  }
  for (const [index, segment] of state.analysis.segments.entries()) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'chord-cell';
    cell.dataset.chordIndex = String(index);
    const name = document.createElement('strong'); name.textContent = segment.name;
    const time = document.createElement('small'); time.textContent = `${formatTime(segment.startTime)} – ${formatTime(segment.endTime)}`;
    const confidence = document.createElement('div');
    confidence.className = 'chord-confidence';
    const bar = document.createElement('span');
    bar.style.setProperty('--confidence', `${Math.round(segment.confidence * 100)}%`);
    confidence.append(bar);
    cell.append(name, time, confidence);
    cell.addEventListener('click', () => seekTo(segment.startTime));
    cell.addEventListener('dblclick', () => {
      const edited = prompt('Chord name:', segment.name);
      if (edited?.trim()) {
        segment.name = edited.trim(); segment.manual = true; name.textContent = segment.name;
      }
    });
    root.append(cell);
  }
}

function renderLyrics() {
  const root = $('#lyrics-list');
  root.replaceChildren();
  if (!state.model?.lyrics.length) {
    root.append(emptyNode(state.model ? 'This file does not contain lyrics.' : 'Lyrics appear after loading a MIDI or KAR file.'));
    return;
  }
  state.model.lyrics.forEach((lyric, index) => {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'lyric-row'; row.dataset.lyricIndex = String(index);
    const time = document.createElement('span'); time.className = 'lyric-time'; time.textContent = formatTime(lyric.time);
    const text = document.createElement('span'); text.textContent = lyric.text;
    row.append(time, text);
    row.addEventListener('click', () => seekTo(lyric.time));
    root.append(row);
  });
}

function renderMarkers() {
  const root = $('#marker-list');
  root.replaceChildren();
  for (const marker of state.markers) {
    const chip = document.createElement('div');
    chip.className = 'marker-chip';
    const stamp = document.createElement('time'); stamp.textContent = formatTime(marker.time);
    const name = document.createElement('span'); name.textContent = marker.name;
    chip.append(stamp, name);
    chip.addEventListener('click', () => seekTo(marker.time));
    if (marker.source !== 'file') {
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Delete marker';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        state.markers = state.markers.filter((item) => item !== marker);
        renderMarkers(); saveFileSettings();
      });
      chip.append(remove);
    }
    root.append(chip);
  }
  $('#loop-start-label').textContent = formatTime(state.loop.start);
  $('#loop-end-label').textContent = formatTime(state.loop.end);
  renderSeekMarkers();
}

function renderSeekMarkers() {
  const root = $('#seek-markers');
  root.replaceChildren();
  if (!state.model?.duration) return;
  for (const marker of state.markers) {
    const line = document.createElement('span');
    line.className = 'seek-marker';
    line.style.left = `${clamp(marker.time / state.model.duration * 100, 0, 100)}%`;
    root.append(line);
  }
}

function renderInfo() {
  const root = $('#file-info');
  root.replaceChildren();
  if (!state.model) return root.append(emptyNode('File details appear here.'));
  const stats = state.model.stats;
  const info = [
    ['File', state.file.name], ['MIDI format', `Type ${stats.format}`], ['Duration', formatTime(stats.duration)],
    ['Tracks', stats.tracks], ['Channels', stats.channels], ['Notes', stats.notes.toLocaleString()],
    ['Events', stats.events.toLocaleString()], ['Resolution', `${state.model.ticksPerBeat} PPQN`],
    ['Tempo changes', stats.tempos], ['Lyrics', stats.lyrics], ['Markers', state.markers.length],
    ['Detected key', state.analysis?.key?.name || 'Analysing…'],
    ['Performance mode', stats.isBlackMIDI ? 'Black MIDI optimisations' : 'Standard']
  ];
  for (const [label, value] of info) {
    const card = document.createElement('div'); card.className = 'info-card';
    const small = document.createElement('small'); small.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = String(value);
    card.append(small, strong); root.append(card);
  }
}

function emptyNode(text) {
  const node = document.createElement('div'); node.className = 'empty-list'; node.textContent = text; return node;
}

function renderRecents() {
  const root = $('#recent-list'); root.replaceChildren();
  if (!store.recents.length) return root.append(emptyNode('Files you open will appear here.'));
  store.recents.forEach((file, index) => {
    const item = createFileItem(file, () => {
      if (!file.path) return toast('Choose this file again', 'Browser-opened files cannot be reopened automatically.');
      loadDescriptor({ ...file });
    });
    const more = $('.file-more', item);
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      addFileToChosenPlaylist(file);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault(); store.removeRecent(index); renderRecents();
    });
    root.append(item);
  });
}

function createFileItem(file, activate) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'file-item';
  const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = file.name?.toLowerCase().endsWith('.kar') ? 'KAR' : 'MID';
  const copy = document.createElement('span'); copy.className = 'file-copy';
  const name = document.createElement('strong'); name.textContent = file.name || 'Unknown file';
  const meta = document.createElement('small'); meta.textContent = file.path ? 'On this PC' : `${formatBytes(file.size || 0)} · choose to reopen`;
  copy.append(name, meta);
  const more = document.createElement('span'); more.className = 'file-more'; more.textContent = '⋮';
  button.append(icon, copy, more); button.addEventListener('click', activate);
  return button;
}

function renderPlaylists() {
  const list = $('#playlist-list'); list.replaceChildren();
  for (const playlist of store.playlists) {
    const item = document.createElement('button'); item.type = 'button'; item.className = `playlist-item ${state.selectedPlaylist === playlist.id ? 'active' : ''}`;
    const icon = document.createElement('span'); icon.textContent = playlist.id === 'favourites' ? '★' : '≡'; icon.style.color = 'var(--accent)';
    const name = document.createElement('span'); name.textContent = playlist.name;
    const count = document.createElement('span'); count.className = 'playlist-count'; count.textContent = playlist.files.length;
    item.append(icon, name, count);
    item.addEventListener('click', () => { state.selectedPlaylist = playlist.id; renderPlaylists(); });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (playlist.id === 'favourites') return;
      const action = prompt('Type a new name, or leave empty to delete:', playlist.name);
      if (action === null) return;
      if (!action.trim()) store.deletePlaylist(playlist.id); else store.renamePlaylist(playlist.id, action);
      renderPlaylists();
    });
    list.append(item);
  }
  const detail = $('#playlist-detail'); detail.replaceChildren();
  const selected = store.playlists.find((item) => item.id === state.selectedPlaylist);
  if (!selected?.files.length) return detail.append(emptyNode('Add files from Recent, or press Ctrl+D for the loaded file.'));
  selected.files.forEach((file, index) => {
    const item = createFileItem(file, () => {
      if (!file.path) return toast('Choose this file again', 'Its original path was not available when it was added.');
      state.queue = selected.files.map((entry) => ({ ...entry }));
      state.queueIndex = index;
      loadDescriptor({ ...file });
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault(); store.removeFromPlaylist(selected.id, index); renderPlaylists();
    });
    detail.append(item);
  });
}

function addFileToChosenPlaylist(file) {
  const names = store.playlists.map((playlist, index) => `${index + 1}. ${playlist.name}`).join('\n');
  const answer = prompt(`Add to which playlist?\n${names}`, '1');
  const index = Number(answer) - 1;
  const playlist = store.playlists[index];
  if (!playlist) return;
  store.addToPlaylist(playlist.id, file);
  renderPlaylists();
  toast('Added to playlist', playlist.name, 'success');
}

function renderSoundFonts() {
  const root = $('#soundfont-list'); root.replaceChildren();
  const banks = engine.getSoundBanks();
  if (!banks.length) return root.append(emptyNode('The engine will load when you open a MIDI or add a SoundFont.'));
  banks.forEach((bank, index) => {
    const row = document.createElement('div'); row.className = 'soundfont-row'; row.dataset.bankId = bank.id;
    row.classList.toggle('disabled', !bank.enabled);
    row.classList.toggle('expanded', expandedSoundFontId === bank.id);
    const handle = document.createElement('button');
    handle.className = 'bank-drag-handle'; handle.type = 'button'; handle.textContent = '⠿'; handle.draggable = true;
    handle.title = 'Drag to change priority'; handle.setAttribute('aria-label', `Move ${bank.name}`); handle.setAttribute('aria-grabbed', 'false');
    const icon = document.createElement('span'); icon.className = 'bank-icon'; icon.textContent = bank.details?.type || 'SF';
    const copy = document.createElement('div'); copy.className = 'soundfont-copy';
    const name = document.createElement('strong'); name.textContent = bank.name;
    const status = bank.enabled ? `Active priority ${bank.priority}` : `Disabled · stack position ${index + 1}`;
    const offsetText = bank.bankOffset ? ` · bank offset +${bank.bankOffset}` : '';
    const presetText = bank.details ? ` · ${bank.details.presetCount} presets` : '';
    const meta = document.createElement('small'); meta.textContent = `${formatBytes(bank.size)} · ${bank.builtIn ? 'Built-in' : 'Custom'}${presetText}${offsetText} · ${status}`;
    copy.append(name, meta);
    const enabledLabel = document.createElement('label'); enabledLabel.className = 'bank-enabled-toggle';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = bank.enabled !== false;
    enabled.setAttribute('aria-label', `Enable ${bank.name}`);
    const enabledText = document.createElement('span'); enabledText.textContent = 'Enabled';
    enabledLabel.append(enabled, enabledText);
    const actions = document.createElement('div'); actions.className = 'bank-actions';
    const detailsButton = document.createElement('button'); detailsButton.className = 'bank-tool-button'; detailsButton.type = 'button';
    detailsButton.textContent = expandedSoundFontId === bank.id ? 'Hide tools' : 'Tools';
    const solo = document.createElement('button'); solo.className = `bank-tool-button ${bank.soloed ? 'active' : ''}`; solo.type = 'button';
    solo.textContent = bank.soloed ? 'Unsolo' : 'Solo';
    actions.append(detailsButton, solo);
    row.append(handle, icon, copy, enabledLabel, actions);

    handle.addEventListener('dragstart', (event) => {
      draggedSoundFontId = bank.id;
      row.classList.add('dragging');
      handle.setAttribute('aria-grabbed', 'true');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', bank.id);
    });
    handle.addEventListener('dragend', () => {
      draggedSoundFontId = null;
      handle.setAttribute('aria-grabbed', 'false');
      row.classList.remove('dragging');
      clearSoundFontDropIndicators();
      $('#visual-shell').classList.remove('dragging');
    });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const ids = engine.getSoundBanks().map((item) => item.id);
      const sourceIndex = ids.indexOf(bank.id);
      const targetIndex = sourceIndex + (event.key === 'ArrowUp' ? -1 : 1);
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
      reorderSoundFontStack(bank.id, ids[targetIndex], event.key === 'ArrowDown');
    });
    row.addEventListener('dragover', (event) => {
      if (!draggedSoundFontId || draggedSoundFontId === bank.id) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      clearSoundFontDropIndicators();
      const after = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('drop', (event) => {
      if (!draggedSoundFontId || draggedSoundFontId === bank.id) return;
      event.preventDefault(); event.stopPropagation();
      const after = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
      reorderSoundFontStack(draggedSoundFontId, bank.id, after);
      draggedSoundFontId = null;
      clearSoundFontDropIndicators();
    });
    enabled.addEventListener('change', async () => {
      enabled.disabled = true;
      try {
        await engine.setSoundBankEnabled(bank.id, enabled.checked);
        persistSoundFontStack();
        renderSoundFonts();
        toast(enabled.checked ? 'SoundFont enabled' : 'SoundFont disabled', bank.name, 'success');
      } catch (error) {
        enabled.checked = bank.enabled !== false;
        enabled.disabled = false;
        friendlyError(error);
      }
    });
    detailsButton.addEventListener('click', async () => {
      if (expandedSoundFontId === bank.id) {
        expandedSoundFontId = null;
        renderSoundFonts();
        return;
      }
      expandedSoundFontId = bank.id;
      if (!bank.details) {
        detailsButton.disabled = true;
        detailsButton.textContent = 'Inspecting…';
        try { await engine.inspectSoundBank(bank.id); }
        catch (error) { friendlyError(error); }
      }
      renderSoundFonts();
    });
    solo.addEventListener('click', async () => {
      solo.disabled = true;
      try {
        const soloed = await engine.toggleSoundBankSolo(bank.id);
        persistSoundFontStack();
        renderSoundFonts();
        toast(soloed ? 'SoundFont soloed' : 'SoundFont stack restored', bank.name, 'success');
      } catch (error) { friendlyError(error); renderSoundFonts(); }
    });
    if (!bank.builtIn) {
      const remove = document.createElement('button'); remove.className = 'remove-bank'; remove.type = 'button'; remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        try {
          await engine.removeSoundBank(bank.id);
          persistSoundFontStack();
          renderSoundFonts();
        } catch (error) { friendlyError(error); }
      });
      actions.append(remove);
    }
    if (expandedSoundFontId === bank.id) {
      row.append(createSoundFontTools(bank));
    }
    root.append(row);
  });
}

function createSoundFontTools(bank) {
  const tools = document.createElement('div');
  tools.className = 'soundfont-tools';
  const details = bank.details;

  const info = document.createElement('div');
  info.className = 'soundfont-metadata';
  if (details) {
    const title = details.internalName && details.internalName !== bank.name ? details.internalName : `${details.type} sound bank`;
    const byline = [details.author, details.product, details.version ? `v${details.version}` : ''].filter(Boolean).join(' · ');
    info.innerHTML = `<strong></strong><span></span><small></small>`;
    $('strong', info).textContent = title;
    $('span', info).textContent = byline || 'No author metadata';
    $('small', info).textContent = `${details.melodicPresetCount} melodic · ${details.drumPresetCount} drum · ${details.instrumentCount} instruments · ${details.sampleCount} samples`;
  } else {
    info.textContent = 'Preset metadata could not be read, but priority and bank-offset tools are still available.';
  }

  const controls = document.createElement('div');
  controls.className = 'soundfont-tool-grid';
  const offsetLabel = document.createElement('label');
  offsetLabel.innerHTML = '<span>Bank offset</span>';
  const offset = document.createElement('input'); offset.type = 'number'; offset.min = '0'; offset.max = '127'; offset.step = '1'; offset.value = String(bank.bankOffset || 0);
  offset.title = 'Shift every preset to a different MIDI bank MSB';
  offsetLabel.append(offset);

  const moveTop = document.createElement('button'); moveTop.type = 'button'; moveTop.className = 'bank-tool-button'; moveTop.textContent = 'Move to top';
  const moveBottom = document.createElement('button'); moveBottom.type = 'button'; moveBottom.className = 'bank-tool-button'; moveBottom.textContent = 'Move to bottom';
  controls.append(offsetLabel, moveTop, moveBottom);

  offset.addEventListener('change', async () => {
    offset.disabled = true;
    try {
      const appliedOffset = await engine.setSoundBankOffset(bank.id, Number(offset.value));
      persistSoundFontStack();
      renderSoundFonts();
      toast('Bank offset updated', `${bank.name} now uses +${appliedOffset}`, 'success');
    } catch (error) { friendlyError(error); renderSoundFonts(); }
  });
  moveTop.addEventListener('click', () => moveSoundFontToEdge(bank.id, true));
  moveBottom.addEventListener('click', () => moveSoundFontToEdge(bank.id, false));

  tools.append(info, controls);
  if (details?.presets?.length) {
    const audition = document.createElement('div');
    audition.className = 'soundfont-audition';
    const presetSelect = document.createElement('select');
    details.presets.forEach((preset, presetIndex) => {
      const prefix = preset.isDrum ? 'DRUM' : `B${preset.bankMSB}:${preset.bankLSB}`;
      presetSelect.append(new Option(`${prefix} · P${preset.program + 1} · ${preset.name}`, String(presetIndex)));
    });
    const firstMelodic = details.presets.findIndex((preset) => !preset.isDrum);
    presetSelect.value = String(Math.max(0, firstMelodic));
    const note = document.createElement('input'); note.type = 'number'; note.min = '0'; note.max = '127'; note.value = '60'; note.title = 'Audition MIDI note';
    const velocity = document.createElement('input'); velocity.type = 'number'; velocity.min = '1'; velocity.max = '127'; velocity.value = '105'; velocity.title = 'Audition velocity';
    const play = document.createElement('button'); play.type = 'button'; play.className = 'button accent'; play.textContent = '▶ Audition preset';
    audition.append(presetSelect, note, velocity, play);
    play.addEventListener('click', async () => {
      const preset = details.presets[Number(presetSelect.value)] || details.presets[0];
      play.disabled = true; play.textContent = 'Playing…';
      try { await engine.auditionSoundBank(bank.id, preset, { note: Number(note.value), velocity: Number(velocity.value) }); }
      catch (error) { friendlyError(error); }
      finally { play.disabled = false; play.textContent = '▶ Audition preset'; }
    });
    tools.append(audition);
  }
  return tools;
}

function moveSoundFontToEdge(id, top) {
  const ids = engine.getSoundBanks().map((bank) => bank.id).filter((bankId) => bankId !== id);
  engine.setSoundBankOrder(top ? [id, ...ids] : [...ids, id]);
  persistSoundFontStack();
  renderSoundFonts();
  focusSoundFontHandle(id);
}

function clearSoundFontDropIndicators() {
  $$('.soundfont-row').forEach((row) => row.classList.remove('drop-before', 'drop-after'));
}

function focusSoundFontHandle(id) {
  requestAnimationFrame(() => {
    const row = $$('.soundfont-row').find((item) => item.dataset.bankId === id);
    row?.querySelector('.bank-drag-handle')?.focus();
  });
}

function reorderSoundFontStack(sourceId, targetId, placeAfter) {
  const current = engine.getSoundBanks().map((bank) => bank.id);
  const next = moveSoundBank(current, sourceId, targetId, placeAfter);
  if (next.every((id, index) => id === current[index])) return;
  engine.setSoundBankOrder(next);
  persistSoundFontStack();
  renderSoundFonts();
  focusSoundFontHandle(sourceId);
}

function renderPerspectives() {
  const root = $('#perspective-list'); root.replaceChildren();
  const entries = [
    ...Object.entries(PERSPECTIVES).map(([id, value]) => ({ id, ...value, builtIn: true })),
    ...store.customPerspectives
  ];
  for (const perspective of entries) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'perspective-row';
    const icon = document.createElement('span'); icon.className = 'bank-icon'; icon.textContent = perspective.view === 'karaoke' ? 'Aa' : '◫';
    const copy = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = perspective.name;
    const meta = document.createElement('small'); meta.textContent = `${perspective.view} · ${perspective.sidebar ? 'library shown' : 'focus view'}`;
    copy.append(name, meta); const mark = document.createElement('span'); mark.textContent = perspective.id === state.perspective ? '✓' : '';
    row.append(icon, copy, mark);
    row.addEventListener('click', () => { applyPerspective(perspective); $('#perspective-dialog').close(); });
    row.addEventListener('contextmenu', (event) => {
      if (perspective.builtIn) return; event.preventDefault(); store.deletePerspective(perspective.id); renderPerspectives();
    });
    root.append(row);
  }
}

function applyPerspective(perspectiveOrId) {
  const perspective = typeof perspectiveOrId === 'string'
    ? (PERSPECTIVES[perspectiveOrId] ? { id: perspectiveOrId, ...PERSPECTIVES[perspectiveOrId] } : store.customPerspectives.find((item) => item.id === perspectiveOrId))
    : perspectiveOrId;
  if (!perspective) return;
  state.perspective = perspective.id;
  store.updateSettings({ lastPerspective: perspective.id });
  $('#library-sidebar').hidden = !perspective.sidebar;
  $('.work-area').style.gridTemplateColumns = perspective.sidebar ? '' : '1fr';
  $('#perspective-label').textContent = perspective.name;
  setView(perspective.view);
  activateDetailTab(perspective.bottomPanel === 'lyrics' ? 'lyrics' : perspective.bottomPanel === 'chords' ? 'chords' : 'mixer');
  document.body.classList.toggle('compact-header', Boolean(perspective.compactHeader));
  state.dirtyVisual = true;
}

function activateDetailTab(name) {
  $$('.detail-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.detailTab === name));
  $$('.detail-content').forEach((panel) => panel.classList.toggle('active', panel.id === `${name}-panel`));
}

function updateStatus(time) {
  if (!state.model) return;
  const signature = state.model.signatureAt(time);
  $('#signature-pill').textContent = `${signature.numerator}/${signature.denominator}`;
  $('#key-pill').textContent = state.model.keyAt(time)?.name || state.analysis?.key?.name || 'Key —';
  $('#voice-pill').textContent = `${engine.synth?.voiceCount || 0} voices`;
}

function updateCurrentRows(time) {
  if (state.analysis) {
    const chord = chordAt(state.analysis, time);
    $$('.chord-cell.current').forEach((cell) => cell.classList.remove('current'));
    if (chord) {
      const index = state.analysis.segments.indexOf(chord);
      const current = $(`.chord-cell[data-chord-index="${index}"]`);
      current?.classList.add('current');
    }
  }
  if (state.model?.lyrics.length) {
    const index = state.model.lyricAt(time).index;
    $$('.lyric-row.current').forEach((row) => row.classList.remove('current'));
    $(`.lyric-row[data-lyric-index="${Math.max(0, index)}"]`)?.classList.add('current');
  }
}

function updateMeters() {
  if (!engine.synth) return;
  $$('[data-meter-channel]').forEach((meter) => {
    const channel = Number(meter.dataset.meterChannel);
    const voices = engine.synth.midiChannels[channel]?.voiceCount || 0;
    const level = clamp((voices ? 18 + Math.log2(voices + 1) * 18 : 0) + Math.random() * (voices ? 12 : 0), 0, 100);
    $('span', meter).style.setProperty('--level', `${level}%`);
  });
}

function flattenActiveNotes() {
  const active = new Array(128).fill(false);
  engine.activeNotes.forEach((set) => set.forEach((note) => { active[note] = true; }));
  return active;
}

let lastFrame = 0;
let lastRowsUpdate = 0;
function animationLoop(timestamp) {
  const playing = state.model && !engine.paused;
  const shouldRender = playing || state.dirtyVisual || timestamp - lastFrame > 750;
  if (shouldRender) {
    const time = state.model ? engine.currentTime : 0;
    if (state.model) {
      engine.updateLoop();
      engine.tickMetronome(state.model);
      if (!state.seeking) $('#seek').value = String(clamp(time, 0, state.model.duration));
      $('#current-time').textContent = formatTime(time);
      updateStatus(time);
      visualizer.activeNotes = flattenActiveNotes();
      visualizer.channelState = state.channelSettings;
      if (state.view === 'spectrum') {
        visualizer.setAudioData(engine.getSpectrum(spectrumBuffer), engine.getWaveform(waveformBuffer));
      }
      if (timestamp - lastRowsUpdate > 180) {
        updateCurrentRows(time); updateMeters(); lastRowsUpdate = timestamp;
      }
    }
    visualizer.render(time, state.dirtyVisual);
    state.dirtyVisual = false;
    lastFrame = timestamp;
  }
  requestAnimationFrame(animationLoop);
}

async function saveBlob(blob, suggestedName) {
  if (window.native?.beginSave && window.native?.appendSave && window.native?.finishSave) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const session = await window.native.beginSave(suggestedName, bytes.byteLength);
    const chunkSize = 384 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      let binary = '';
      for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
      await window.native.appendSave(session.id, btoa(binary));
    }
    const result = await window.native.finishSave(session.id);
    toast('File exported', result.path || suggestedName, 'success');
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = suggestedName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportBaseName() {
  return (state.file?.name || 'MIDI Voyager export').replace(/\.(mid|midi|kar|rmi|rmid|xmf)$/i, '');
}

async function exportMIDI() {
  try {
    if (!state.model) return;
    const buffer = engine.exportMIDI(state.markers);
    await saveBlob(new Blob([buffer], { type: 'audio/midi' }), `${exportBaseName()} - Voyager.mid`);
    $('#export-dialog').close();
  } catch (error) { friendlyError(error); }
}

async function exportWAV() {
  if (!state.model) return;
  const progress = $('#export-progress');
  progress.hidden = false;
  $$('.export-choice').forEach((button) => { button.disabled = true; });
  try {
    const blob = await engine.renderWAV(state.markers, (amount) => {
      progress.style.setProperty('--progress', `${Math.round(amount * 100)}%`);
    });
    await saveBlob(blob, `${exportBaseName()} - Voyager.wav`);
    $('#export-dialog').close();
  } catch (error) { friendlyError(error); }
  finally {
    progress.hidden = true;
    $$('.export-choice').forEach((button) => { button.disabled = false; });
  }
}

async function exportLyrics() {
  if (!state.model) return;
  const lines = [`${exportBaseName()} — lyrics & chords`, ''];
  for (const lyric of state.model.lyrics) {
    const chord = chordAt(state.analysis, lyric.time);
    lines.push(`[${formatTime(lyric.time)}]${chord?.name && chord.name !== '—' ? ` [${chord.name}]` : ''} ${lyric.text}`);
  }
  if (!state.model.lyrics.length && state.analysis) {
    state.analysis.segments.filter((segment) => segment.name !== '—').forEach((segment) => lines.push(`[${formatTime(segment.startTime)}] ${segment.name}`));
  }
  await saveBlob(new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' }), `${exportBaseName()} - lyrics and chords.txt`);
  $('#export-dialog').close();
}

function renderRepairSummary(report) {
  const root = $('#repair-summary');
  root.replaceChildren();
  if (!report) {
    const scanning = document.createElement('div');
    scanning.className = 'repair-scanning';
    scanning.textContent = 'Scanning MIDI event structure…';
    root.append(scanning);
    $('#repair-export').disabled = true;
    return;
  }
  const headline = document.createElement('div');
  headline.className = `repair-headline ${report.healthy ? 'healthy' : report.errorCount ? 'damaged' : 'warning'}`;
  const badge = document.createElement('span'); badge.textContent = report.healthy ? '✓' : report.errorCount ? '!' : 'i';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = report.healthy ? 'No structural problems detected' : `${report.totalIssues.toLocaleString()} repairable event issue${report.totalIssues === 1 ? '' : 's'} found`;
  const meta = document.createElement('small');
  meta.textContent = `${report.trackCount} tracks · ${report.eventCount.toLocaleString()} events · original remains untouched`;
  copy.append(title, meta); headline.append(badge, copy); root.append(headline);

  if (report.issues.length) {
    const list = document.createElement('div'); list.className = 'repair-issue-list';
    for (const issue of report.issues) {
      const item = document.createElement('div'); item.className = `repair-issue ${issue.severity}`;
      const count = document.createElement('strong'); count.textContent = issue.count.toLocaleString();
      const description = document.createElement('span');
      const label = document.createElement('b'); label.textContent = issue.label;
      const detail = document.createElement('small'); detail.textContent = issue.description;
      description.append(label, detail); item.append(count, description); list.append(item);
    }
    root.append(list);
  }
  $('#repair-export').disabled = report.healthy;
}

async function openRepairTool() {
  if (!state.model) return toast('Open a MIDI file first', 'The repair scanner needs a loaded song.');
  $('#repair-dialog').showModal();
  renderRepairSummary(null);
  await nextFrame();
  try {
    state.repairReport = inspectMIDI(state.model.arrayBuffer);
    renderRepairSummary(state.repairReport);
  } catch (error) {
    $('#repair-dialog').close();
    friendlyError(error);
  }
}

async function exportRepairedMIDI() {
  if (!state.model) return;
  const button = $('#repair-export');
  button.disabled = true;
  button.textContent = 'Repairing…';
  await nextFrame();
  try {
    const result = repairMIDI(state.model.arrayBuffer, {
      closeStuckNotes: $('#repair-stuck').checked,
      removeOrphanNoteOffs: $('#repair-orphans').checked,
      resolveOverlaps: $('#repair-overlaps').checked,
      normalizeZeroVelocity: $('#repair-zero-velocity').checked,
      fixInvalidData: $('#repair-values').checked,
      removeExactDuplicates: $('#repair-duplicates').checked,
      normalizeTrackEndings: $('#repair-endings').checked,
      clampTempos: $('#repair-tempos').checked
    });
    if (!result.changed) {
      toast('No selected repairs were needed', 'Enable another repair operation or close the MIDI Doctor.');
      return;
    }
    await saveBlob(new Blob([result.buffer], { type: 'audio/midi' }), `${exportBaseName()} - Repaired.mid`);
    $('#repair-dialog').close();
    toast('MIDI repair complete', `${result.fixedTotal.toLocaleString()} event repairs applied to the saved copy.`, 'success');
  } catch (error) { friendlyError(error); }
  finally {
    button.textContent = 'Repair & save copy';
    button.disabled = state.repairReport?.healthy ?? true;
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function createDemoMIDI() {
  const tpb = 480;
  const note = (deltaTime, noteNumber, duration, velocity = 88, channel = 0) => [
    { deltaTime, type: 'noteOn', channel, noteNumber, velocity },
    { deltaTime: duration, type: 'noteOff', channel, noteNumber, velocity: 0 }
  ];
  const conductor = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'Voyager Demo' },
    { deltaTime: 0, meta: true, type: 'setTempo', microsecondsPerBeat: 500000 },
    { deltaTime: 0, meta: true, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
    { deltaTime: 0, meta: true, type: 'keySignature', key: 0, scale: 0 },
    { deltaTime: 0, meta: true, type: 'lyrics', text: 'Welcome to MIDI Voyager' },
    { deltaTime: tpb * 4, meta: true, type: 'lyrics', text: 'Every note becomes a world of colour' },
    { deltaTime: tpb * 4, meta: true, type: 'lyrics', text: 'Open your own MIDI to begin' },
    { deltaTime: tpb * 4, meta: true, type: 'marker', text: 'Finale' },
    { deltaTime: tpb * 4, meta: true, type: 'endOfTrack' }
  ];
  const chords = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'Crystal Piano' },
    { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 4 }
  ];
  const progression = [[60,64,67], [57,60,64], [65,69,72], [67,71,74]];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    const chord = progression[cycle % progression.length];
    chord.forEach((pitch) => chords.push({ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: pitch, velocity: 68 }));
    chord.forEach((pitch, index) => chords.push({ deltaTime: index === 0 ? tpb * 4 : 0, type: 'noteOff', channel: 0, noteNumber: pitch, velocity: 0 }));
  }
  chords.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });
  const melody = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'Voyager Lead' },
    { deltaTime: 0, type: 'programChange', channel: 1, programNumber: 81 }
  ];
  const tune = [72,76,79,84,79,76,74,77,81,84,81,77,72,74,76,79,84,83,79,76,74,71,72,67,72,76,79,84,86,84,79,76];
  tune.forEach((pitch, index) => melody.push(...note(index === 0 ? 0 : 0, pitch, tpb / 2, 86 + index % 4 * 8, 1)));
  melody.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });
  const bass = [
    { deltaTime: 0, meta: true, type: 'trackName', text: 'Pulse Bass' },
    { deltaTime: 0, type: 'programChange', channel: 2, programNumber: 38 }
  ];
  [36,36,33,33,41,41,43,43].forEach((pitch, index) => bass.push(...note(index === 0 ? 0 : 0, pitch, tpb * 2, 95, 2)));
  bass.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });
  return new Uint8Array(writeMidi({ header: { format: 1, numTracks: 4, ticksPerBeat: tpb }, tracks: [conductor, chords, melody, bass] })).buffer;
}

function bindUI() {
  renderViewSwitcher(); renderRecents(); renderPlaylists(); renderPerspectives();
  setView(state.view);
  visualizer.setZoom(store.settings.zoom || 1);
  visualizer.colorMode = store.settings.colorMode || 'track';
  visualizer.showPiano = store.settings.showPiano !== false;
  visualizer.showLabels = store.settings.showLabels !== false;
  visualizer.showGrid = store.settings.showGrid !== false;
  visualizer.spectrumTheme = store.settings.spectrumTheme || 'classic';
  visualizer.spectrumGain = Number(store.settings.spectrumGain) || 1;
  $('#color-mode').value = visualizer.colorMode;
  engine.setMasterVolume(store.settings.masterVolume ?? .82);
  engine.setMetronome(Boolean(store.settings.metronome));
  document.body.classList.add(`theme-${store.settings.theme || 'midnight'}`);
  applyPerspective(state.perspective);
  updateTransportLabels();

  $('#open-midi').addEventListener('click', () => openMidiFiles(false));
  $('#open-multiple').addEventListener('click', () => openMidiFiles(true));
  $('#midi-file-input').addEventListener('change', async (event) => {
    const descriptors = descriptorsFromFileList(event.target.files);
    event.target.value = '';
    if (!descriptors.length) return;
    state.queue = descriptors; state.queueIndex = 0;
    await loadDescriptor(descriptors[0]);
  });
  $('#soundfont-file-input').addEventListener('change', async (event) => {
    const descriptors = descriptorsFromFileList(event.target.files); event.target.value = '';
    for (const descriptor of descriptors) await loadSoundFontDescriptor(descriptor);
  });
  $('#demo-button').addEventListener('click', () => {
    const buffer = createDemoMIDI();
    loadDescriptor({ name: 'Voyager Demo.mid', size: buffer.byteLength, path: null }, { buffer });
  });

  $('#play-button').addEventListener('click', togglePlay);
  $('#stop-button').addEventListener('click', () => engine.stop());
  $('#rewind-button').addEventListener('click', () => seekTo(engine.currentTime - 10));
  $('#forward-button').addEventListener('click', () => seekTo(engine.currentTime + 10));
  $('#previous-button').addEventListener('click', () => queueStep(-1));
  $('#next-button').addEventListener('click', () => queueStep(1));
  $('#seek').addEventListener('pointerdown', () => { state.seeking = true; });
  $('#seek').addEventListener('input', () => {
    $('#current-time').textContent = formatTime(Number($('#seek').value));
    visualizer.render(Number($('#seek').value), true);
  });
  $('#seek').addEventListener('change', () => { seekTo(Number($('#seek').value)); state.seeking = false; });
  window.addEventListener('pointerup', () => { if (state.seeking) { seekTo(Number($('#seek').value)); state.seeking = false; } });
  $('#tempo-down').addEventListener('click', () => setRate(state.rate - .05));
  $('#tempo-up').addEventListener('click', () => setRate(state.rate + .05));
  $('#tempo-value').addEventListener('click', () => {
    const result = prompt('Playback speed in percent (10–400):', String(Math.round(state.rate * 100)));
    if (result !== null && Number.isFinite(Number(result))) setRate(Number(result) / 100);
  });
  $('#pitch-down').addEventListener('click', () => setTranspose(state.transpose - 1));
  $('#pitch-up').addEventListener('click', () => setTranspose(state.transpose + 1));
  $('#pitch-value').addEventListener('click', () => {
    const result = prompt('Transpose in semitones (−48 to +48):', String(state.transpose));
    if (result !== null && Number.isFinite(Number(result))) setTranspose(Number(result));
  });
  $('#master-volume').addEventListener('input', () => {
    engine.setMasterVolume(Number($('#master-volume').value));
    store.updateSettings({ masterVolume: engine.masterVolume });
  });
  $('#loop-button').addEventListener('click', () => {
    if (!state.model) return;
    if (state.loop.end <= state.loop.start) { state.loop.start = engine.currentTime; state.loop.end = Math.min(state.model.duration, engine.currentTime + 8); }
    state.loop.enabled = !state.loop.enabled;
    engine.setLoop(state.loop.enabled, state.loop.start, state.loop.end);
    updateTransportLabels(); saveFileSettings();
  });
  $('#metronome-button').addEventListener('click', () => {
    engine.setMetronome(!engine.metronomeEnabled);
    store.updateSettings({ metronome: engine.metronomeEnabled }); updateTransportLabels();
  });
  engine.addEventListener('playstate', (event) => {
    $('#play-button').textContent = event.detail.playing ? 'Ⅱ' : '▶';
    $('#play-button').classList.toggle('playing', event.detail.playing);
  });
  engine.addEventListener('ended', () => {
    $('#play-button').textContent = '▶';
    if (state.queueIndex >= 0 && state.queueIndex < state.queue.length - 1) queueStep(1);
  });

  $('#color-mode').addEventListener('change', () => {
    visualizer.colorMode = $('#color-mode').value;
    store.updateSettings({ colorMode: visualizer.colorMode }); renderMixer(); state.dirtyVisual = true;
  });
  $('#zoom-in').addEventListener('click', () => changeZoom(1.2));
  $('#zoom-out').addEventListener('click', () => changeZoom(1 / 1.2));
  $('#zoom-reset').addEventListener('click', () => setZoom(1));
  $('#fullscreen-button').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else $('#visual-shell').requestFullscreen?.();
  });

  $$('.sidebar-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.sidebar-tab').forEach((item) => item.classList.toggle('active', item === tab));
    $$('.sidebar-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `${tab.dataset.sidebarTab}-pane`));
  }));
  $$('.detail-tab').forEach((tab) => tab.addEventListener('click', () => activateDetailTab(tab.dataset.detailTab)));
  $('#collapse-detail').addEventListener('click', () => { $('.main-stage').classList.toggle('detail-collapsed'); state.dirtyVisual = true; });

  $('#loop-set-start').addEventListener('click', () => {
    state.loop.start = engine.currentTime;
    if (state.loop.end <= state.loop.start) state.loop.end = Math.min(state.model?.duration || state.loop.start + 8, state.loop.start + 8);
    engine.setLoop(state.loop.enabled, state.loop.start, state.loop.end); renderMarkers(); saveFileSettings();
  });
  $('#loop-set-end').addEventListener('click', () => {
    state.loop.end = Math.max(state.loop.start + .05, engine.currentTime);
    engine.setLoop(state.loop.enabled, state.loop.start, state.loop.end); renderMarkers(); saveFileSettings();
  });
  $('#loop-clear').addEventListener('click', () => {
    state.loop = { enabled: false, start: 0, end: state.model?.duration || 0 };
    engine.setLoop(false, 0, state.loop.end); renderMarkers(); updateTransportLabels(); saveFileSettings();
  });
  $('#add-marker').addEventListener('click', () => {
    if (!state.model) return;
    const name = prompt('Marker name:', `Marker ${state.markers.length + 1}`);
    if (!name?.trim()) return;
    state.markers.push({ name: name.trim(), time: engine.currentTime, tick: state.model.secondsToTick(engine.currentTime), source: 'user' });
    state.markers.sort((a, b) => a.time - b.time); renderMarkers(); saveFileSettings();
  });

  $('#settings-button').addEventListener('click', openSettings);
  $$('.settings-nav-item').forEach((button) => button.addEventListener('click', () => {
    $$('.settings-nav-item').forEach((item) => item.classList.toggle('active', item === button));
    $$('.settings-page').forEach((page) => page.classList.toggle('active', page.dataset.settingsContent === button.dataset.settingsPage));
  }));
  bindSettingsFields();
  $('#export-settings').addEventListener('click', () => saveBlob(new Blob([store.exportSettings()], { type: 'application/json' }), 'MIDI Voyager settings.mvs'));
  $('#import-settings').addEventListener('click', () => $('#settings-file-input').click());
  $('#settings-file-input').addEventListener('change', async (event) => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    try { store.importSettings(await file.text()); toast('Settings imported', 'Restart the app to apply every setting.', 'success'); renderPlaylists(); renderRecents(); }
    catch (error) { friendlyError(error); }
  });

  $('#soundfont-button').addEventListener('click', async () => {
    try { await engine.ensureReady(); await restorePersistedSoundFonts(); renderSoundFonts(); $('#soundfont-dialog').showModal(); }
    catch (error) { friendlyError(error); }
  });
  $('#add-soundfont').addEventListener('click', async () => {
    if (!window.native?.openSoundFontFiles) return $('#soundfont-file-input').click();
    try {
      const descriptors = await window.native.openSoundFontFiles();
      for (const descriptor of descriptors || []) await loadSoundFontDescriptor(descriptor);
    } catch (error) { friendlyError(error); }
  });
  $('#enable-all-soundfonts').addEventListener('click', async () => {
    try {
      await engine.enableAllSoundBanks();
      persistSoundFontStack();
      renderSoundFonts();
      toast('All SoundFonts enabled', 'The current priority order has been preserved.', 'success');
    } catch (error) { friendlyError(error); }
  });
  $('#repair-button').addEventListener('click', openRepairTool);
  $('#repair-export').addEventListener('click', exportRepairedMIDI);
  $('#midi-devices-button').addEventListener('click', () => $('#midi-dialog').showModal());
  $('#scan-midi').addEventListener('click', scanMIDIDevices);
  $('#midi-input-select').addEventListener('change', () => engine.selectMIDIInput($('#midi-input-select').value));
  $('#midi-output-select').addEventListener('change', () => engine.selectMIDIOutput($('#midi-output-select').value, store.settings.midiOutputOnly !== false));
  $('#perspective-button').addEventListener('click', () => { renderPerspectives(); $('#perspective-dialog').showModal(); });
  $('#save-perspective').addEventListener('click', () => {
    const name = prompt('Perspective name:', 'My layout'); if (!name?.trim()) return;
    const id = `custom-${Date.now()}`;
    store.savePerspective({ id, name: name.trim(), view: state.view, sidebar: !$('#library-sidebar').hidden, bottomPanel: $('.detail-tab.active')?.dataset.detailTab || 'mixer', compactHeader: false });
    renderPerspectives();
  });

  $('#new-playlist').addEventListener('click', () => {
    const name = prompt('Playlist name:', 'New playlist'); if (!name?.trim()) return;
    const playlist = store.createPlaylist(name); state.selectedPlaylist = playlist.id; renderPlaylists();
  });
  $('#export-button').addEventListener('click', () => {
    if (!state.model) return toast('Open a MIDI file first');
    $('#export-dialog').showModal();
  });
  $('#export-midi').addEventListener('click', exportMIDI);
  $('#export-wav').addEventListener('click', exportWAV);
  $('#export-lyrics').addEventListener('click', exportLyrics);

  const canvas = $('#visualizer');
  canvas.addEventListener('pointerdown', (event) => {
    const note = visualizer.pianoNoteAt(event.clientX, event.clientY);
    if (note === null) return;
    state.pressedPianoNote = note; engine.noteOn(0, note, 105); state.dirtyVisual = true;
  });
  window.addEventListener('pointerup', () => {
    if (state.pressedPianoNote !== null) engine.noteOff(0, state.pressedPianoNote);
    state.pressedPianoNote = null;
  });
  canvas.addEventListener('wheel', (event) => {
    const pageSize = canvas.clientHeight || 800;
    if (event.ctrlKey) {
      event.preventDefault();
      setZoom(visualizer.zoom * visualizerZoomMultiplier(event.deltaX, event.deltaY, event.deltaMode, pageSize));
      return;
    }
    if (!state.model) return;
    const deltaSeconds = visualizerScrollSeconds(
      event.deltaX, event.deltaY, event.deltaMode, visualizer.zoom, state.view, pageSize
    );
    if (!deltaSeconds) return;
    event.preventDefault();
    queueWheelSeek(deltaSeconds);
  }, { passive: false });

  bindDragAndDrop();
  bindKeyboard();
}

function changeZoom(multiplier) { setZoom(visualizer.zoom * multiplier); }
function setZoom(value) {
  visualizer.setZoom(value); $('#zoom-reset').textContent = `${Math.round(visualizer.zoom * 100)}%`;
  store.updateSettings({ zoom: visualizer.zoom }); state.dirtyVisual = true;
}

function openSettings() {
  $('#count-in-setting').value = String(store.settings.countIn || 0);
  $('#max-tempo-setting').value = String(state.maxTempo);
  $('#skip-silence-setting').checked = Boolean(store.settings.skipSilence);
  $('#midi-output-only-setting').checked = store.settings.midiOutputOnly !== false;
  $('#show-piano-setting').checked = visualizer.showPiano;
  $('#show-labels-setting').checked = visualizer.showLabels;
  $('#show-grid-setting').checked = visualizer.showGrid;
  $('#spectrum-theme-setting').value = visualizer.spectrumTheme;
  $('#spectrum-gain-setting').value = String(visualizer.spectrumGain);
  $('#theme-setting').value = store.settings.theme || 'midnight';
  $('#karaoke-color-setting').value = store.settings.karaokeColor || 'gray';
  $('#karaoke-length-setting').value = String(store.settings.karaokeLength || 80);
  $('#settings-dialog').showModal();
}

function bindSettingsFields() {
  $('#count-in-setting').addEventListener('change', () => store.updateSettings({ countIn: Number($('#count-in-setting').value) }));
  $('#max-tempo-setting').addEventListener('change', () => { state.maxTempo = Number($('#max-tempo-setting').value); store.updateSettings({ maxTempo: state.maxTempo }); });
  $('#skip-silence-setting').addEventListener('change', () => {
    store.updateSettings({ skipSilence: $('#skip-silence-setting').checked });
    if (engine.sequencer) engine.sequencer.skipToFirstNoteOn = $('#skip-silence-setting').checked;
  });
  $('#midi-output-only-setting').addEventListener('change', () => store.updateSettings({ midiOutputOnly: $('#midi-output-only-setting').checked }));
  $('#show-piano-setting').addEventListener('change', () => { visualizer.showPiano = $('#show-piano-setting').checked; store.updateSettings({ showPiano: visualizer.showPiano }); state.dirtyVisual = true; });
  $('#show-labels-setting').addEventListener('change', () => { visualizer.showLabels = $('#show-labels-setting').checked; store.updateSettings({ showLabels: visualizer.showLabels }); state.dirtyVisual = true; });
  $('#show-grid-setting').addEventListener('change', () => { visualizer.showGrid = $('#show-grid-setting').checked; store.updateSettings({ showGrid: visualizer.showGrid }); state.dirtyVisual = true; });
  $('#spectrum-theme-setting').addEventListener('change', () => {
    visualizer.spectrumTheme = $('#spectrum-theme-setting').value;
    store.updateSettings({ spectrumTheme: visualizer.spectrumTheme }); state.dirtyVisual = true;
  });
  $('#spectrum-gain-setting').addEventListener('change', () => {
    visualizer.spectrumGain = Number($('#spectrum-gain-setting').value) || 1;
    store.updateSettings({ spectrumGain: visualizer.spectrumGain }); state.dirtyVisual = true;
  });
  $('#theme-setting').addEventListener('change', () => {
    document.body.classList.remove('theme-midnight', 'theme-violet', 'theme-graphite');
    document.body.classList.add(`theme-${$('#theme-setting').value}`); store.updateSettings({ theme: $('#theme-setting').value });
  });
  $('#karaoke-color-setting').addEventListener('change', () => {
    const value = $('#karaoke-color-setting').value; store.updateSettings({ karaokeColor: value });
    document.documentElement.style.setProperty('--karaoke-next', value === 'white' ? '#fff' : value === 'cyan' ? 'var(--accent)' : '#98a4b2');
  });
  $('#karaoke-length-setting').addEventListener('change', () => store.updateSettings({ karaokeLength: Number($('#karaoke-length-setting').value) }));
}

async function scanMIDIDevices() {
  try {
    $('#midi-status').textContent = 'Requesting MIDI access…';
    const devices = await engine.initializeMIDIDevices();
    const input = $('#midi-input-select'); const output = $('#midi-output-select');
    input.replaceChildren(new Option('None', '')); output.replaceChildren(new Option('Internal SoundFont', ''));
    devices.inputs.forEach((device) => input.append(new Option(`${device.name}${device.manufacturer ? ` — ${device.manufacturer}` : ''}`, device.id)));
    devices.outputs.forEach((device) => output.append(new Option(`${device.name}${device.manufacturer ? ` — ${device.manufacturer}` : ''}`, device.id)));
    $('#midi-status').textContent = `${devices.inputs.length} input(s), ${devices.outputs.length} output(s) found.`;
  } catch (error) { $('#midi-status').textContent = error.message; friendlyError(error); }
}

async function openIncomingDescriptors(files) {
  const descriptors = files || [];
  if (!descriptors.length) return;
  const midi = descriptors.filter((item) => !/\.(sf2|sf3|dls|sf2pack)$/i.test(item.name));
  const banks = descriptors.filter((item) => /\.(sf2|sf3|dls|sf2pack)$/i.test(item.name));
  for (const bank of banks) await loadSoundFontDescriptor(bank);
  if (midi.length) { state.queue = midi; state.queueIndex = 0; await loadDescriptor(midi[0]); }
}

function queueIncomingDescriptors(files) {
  incomingFileQueue = incomingFileQueue.then(() => openIncomingDescriptors(files)).catch(friendlyError);
  return incomingFileQueue;
}

function bindDragAndDrop() {
  const shell = $('#visual-shell');
  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    if (draggedSoundFontId) return;
    event.preventDefault(); depth++; shell.classList.add('dragging');
  });
  window.addEventListener('dragover', (event) => { if (!draggedSoundFontId) event.preventDefault(); });
  window.addEventListener('dragleave', (event) => {
    if (draggedSoundFontId) return;
    event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) shell.classList.remove('dragging');
  });
  window.addEventListener('drop', async (event) => {
    if (draggedSoundFontId) { event.preventDefault(); return; }
    event.preventDefault(); depth = 0; shell.classList.remove('dragging');
    const descriptors = descriptorsFromFileList(event.dataTransfer.files);
    await openIncomingDescriptors(descriptors);
  });
  window.__onNativeDrop = queueIncomingDescriptors;
  window.__onNativeOpen = queueIncomingDescriptors;
}

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || $('dialog[open]')) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); openMidiFiles(event.shiftKey); return; }
    if (event.ctrlKey && event.key.toLowerCase() === 'd') {
      event.preventDefault(); if (state.file) { store.addToPlaylist('favourites', state.file); renderPlaylists(); toast('Added to Favourites', state.file.name, 'success'); } return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'e') { event.preventDefault(); if (state.model) $('#export-dialog').showModal(); return; }
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'ArrowLeft') seekTo(engine.currentTime - (event.shiftKey ? 10 : 2));
    else if (event.key === 'ArrowRight') seekTo(engine.currentTime + (event.shiftKey ? 10 : 2));
    else if (event.key === 'Home') engine.stop();
    else if (event.key === '[') setTranspose(state.transpose - 1);
    else if (event.key === ']') setTranspose(state.transpose + 1);
    else if (event.key === '-' || event.key === '_') setRate(state.rate - .05);
    else if (event.key === '=' || event.key === '+') setRate(state.rate + .05);
    else if (/^[1-6]$/.test(event.key)) setView(VIEW_MODES[Number(event.key) - 1].id);
  });
}

window.addEventListener('beforeunload', () => { saveFileSettings(); engine.destroy(); });
document.title = APP_NAME;
bindUI();
Promise.resolve(window.native?.readyForFileOpen?.()).catch(friendlyError);
requestAnimationFrame(animationLoop);
