import {
  CHANNEL_COLORS,
  PITCH_CLASS_COLORS,
  midiNoteName,
  clamp,
  formatTime
} from './constants.js';
import { chordAt, keyPitchClasses } from './chords.js';
import {
  BLACK_KEY_HEIGHT_RATIO,
  PIANO_AREA_HEIGHT,
  createPianoLayout,
  isBlackPianoKey,
  pianoPitchAt,
  visiblePianoRange
} from './piano-layout.js';

function withAlpha(hex, alpha) {
  const value = hex.replace('#', '');
  const number = Number.parseInt(value, 16);
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

export function aggregateSpectrumBands(values, bandCount = 64) {
  const input = values || [];
  const count = Math.max(1, Math.min(128, Math.round(Number(bandCount) || 64)));
  const result = new Float32Array(count);
  if (!input.length) return result;
  for (let band = 0; band < count; band += 1) {
    const start = Math.min(input.length - 1, Math.floor(Math.pow(input.length + 1, band / count) - 1));
    const end = Math.max(start + 1, Math.min(input.length, Math.ceil(Math.pow(input.length + 1, (band + 1) / count) - 1)));
    let energy = 0;
    let peak = 0;
    for (let index = Math.max(0, start); index < end; index += 1) {
      const normalized = Math.max(0, Math.min(255, Number(input[index]) || 0)) / 255;
      energy += normalized * normalized;
      peak = Math.max(peak, normalized);
    }
    const rms = Math.sqrt(energy / Math.max(1, end - Math.max(0, start)));
    result[band] = Math.min(1, rms * 0.72 + peak * 0.38);
  }
  return result;
}

export function activePianoKeyColor(pitch, noteColors, activeNotes = []) {
  if (noteColors?.has?.(pitch)) return noteColors.get(pitch);
  return activeNotes[pitch] ? PITCH_CLASS_COLORS[pitch % 12] : null;
}

export function visualizerTrackColor(trackIndex) {
  const index = Number.isFinite(Number(trackIndex)) ? Math.trunc(Number(trackIndex)) : 0;
  return CHANNEL_COLORS[((index % CHANNEL_COLORS.length) + CHANNEL_COLORS.length) % CHANNEL_COLORS.length];
}

export function mixerSliderColor(tracks, channel, colorMode = 'track') {
  const channelIndex = Number.isFinite(Number(channel)) ? Math.trunc(Number(channel)) : 0;
  if (colorMode === 'channel') {
    return CHANNEL_COLORS[((channelIndex % CHANNEL_COLORS.length) + CHANNEL_COLORS.length) % CHANNEL_COLORS.length];
  }
  const primaryTrack = [...(tracks || [])].sort((left, right) =>
    (Number(right.noteCount) || 0) - (Number(left.noteCount) || 0)
      || (Number(left.index) || 0) - (Number(right.index) || 0)
  )[0];
  return visualizerTrackColor(primaryTrack?.index ?? channelIndex);
}

export class Visualizer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.overlay = overlay;
    this.model = null;
    this.analysis = null;
    this.view = 'waterfall';
    this.zoom = 1;
    this.colorMode = 'track';
    this.showPiano = true;
    this.showLabels = true;
    this.showGrid = true;
    this.spectrumTheme = 'classic';
    this.spectrumGain = 1;
    this.spectrumData = new Uint8Array(256);
    this.waveformData = new Uint8Array(512).fill(128);
    this.spectrumLevels = new Float32Array(64);
    this.spectrumPeaks = new Float32Array(64);
    this.background = '#070a12';
    this.channelState = [];
    this.activeNotes = [];
    this.lastOverlayKey = '';
    this.lastSize = { width: 0, height: 0, dpr: 1 };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  setModel(model) {
    this.model = model;
    this.lastOverlayKey = '';
    this.render(0, true);
  }

  setAnalysis(analysis) {
    this.analysis = analysis;
    this.render(0, true);
  }

  setView(view) {
    this.view = view;
    this.canvas.hidden = view === 'karaoke' || view === 'events';
    this.overlay.hidden = !(view === 'karaoke' || view === 'events');
    this.lastOverlayKey = '';
    this.render(0, true);
  }

  setZoom(zoom) {
    this.zoom = clamp(Number(zoom) || 1, 0.25, 6);
  }

  setAudioData(spectrum, waveform) {
    if (spectrum?.length) this.spectrumData.set(spectrum.subarray ? spectrum.subarray(0, this.spectrumData.length) : spectrum);
    if (waveform?.length) this.waveformData.set(waveform.subarray ? waveform.subarray(0, this.waveformData.length) : waveform);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(220, Math.round(rect.height));
    if (this.lastSize.width === width && this.lastSize.height === height && this.lastSize.dpr === dpr) return;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastSize = { width, height, dpr };
  }

  render(time = 0, force = false) {
    this.resize();
    if (this.view === 'karaoke' || this.view === 'events') {
      this._renderOverlay(time, force);
      return;
    }
    const { width, height } = this.lastSize;
    const ctx = this.context;
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, width, height);
    if (this.view === 'spectrum') {
      this._drawSpectrum(ctx, width, height, time);
      return;
    }
    if (!this.model) {
      this._emptyState(ctx, width, height);
      return;
    }
    if (this.view === 'roll') this._drawRoll(ctx, width, height, time);
    else if (this.view === 'staff') this._drawStaff(ctx, width, height, time);
    else this._drawWaterfall(ctx, width, height, time);
  }

  _emptyState(ctx, width, height) {
    const gradient = ctx.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, Math.min(width, height) * 0.55);
    gradient.addColorStop(0, 'rgba(43, 212, 255, .13)');
    gradient.addColorStop(1, 'rgba(6, 8, 16, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eaf8ff';
    ctx.font = '600 24px "Segoe UI", sans-serif';
    ctx.fillText('Drop a MIDI or KAR file here', width / 2, height / 2 - 8);
    ctx.fillStyle = '#71869e';
    ctx.font = '14px "Segoe UI", sans-serif';
    ctx.fillText('or use Open MIDI in the top-left corner', width / 2, height / 2 + 24);
  }

  _range() {
    return visiblePianoRange(this.model.noteRange, this.zoom);
  }

  _noteColor(note) {
    if (this.colorMode === 'pitch') return PITCH_CLASS_COLORS[note.pitch % 12];
    if (this.colorMode === 'channel') return CHANNEL_COLORS[note.channel % CHANNEL_COLORS.length];
    if (this.colorMode === 'velocity') {
      const hue = 205 + note.velocity / 127 * 130;
      return `hsl(${hue % 360} 88% ${48 + note.velocity / 127 * 15}%)`;
    }
    if (this.colorMode === 'out-of-key') {
      const key = this.analysis?.key;
      return keyPitchClasses(key).has(note.pitch % 12) ? '#54d8ff' : '#ff4f72';
    }
    return visualizerTrackColor(note.track);
  }

  _isMuted(note) {
    const state = this.channelState[note.channel];
    if (!state) return false;
    const anySolo = this.channelState.some((item) => item?.solo);
    return state.muted || (anySolo && !state.solo);
  }

  _drawWaterfall(ctx, width, height, time) {
    const pianoHeight = this.showPiano ? PIANO_AREA_HEIGHT : 0;
    const playY = height - pianoHeight;
    const range = this._range();
    const pianoLayout = createPianoLayout(range.min, range.max, width);
    const secondsAhead = clamp(8 / Math.sqrt(this.zoom), 1.5, 16);
    const secondsBehind = 0.65;

    if (this.showGrid) this._drawWaterfallGrid(ctx, width, playY, time, secondsAhead);
    const notes = this.model.notesInRange(time - secondsBehind, time + secondsAhead, 25_000);
    const dense = notes.length > 9000;
    const activeKeyColors = new Map();
    const drawNotes = (blackPass) => {
      for (const note of notes) {
        if (isBlackPianoKey(note.pitch) !== blackPass || note.pitch < range.min || note.pitch > range.max || this._isMuted(note)) continue;
        const key = pianoLayout.byPitch.get(note.pitch);
        if (!key) continue;
        const inset = Math.min(1.5, key.width * 0.08);
        const x = key.x + inset;
        const noteWidth = Math.max(1, key.width - inset * 2);
        const yStart = playY - (note.start - time) / secondsAhead * playY;
        const yEnd = playY - (note.end - time) / secondsAhead * playY;
        const top = Math.min(yStart, yEnd);
        const bottom = Math.max(yStart, yEnd);
        const color = this._noteColor(note);
        const active = note.start <= time && note.end >= time;
        if (active) activeKeyColors.set(note.pitch, color);
        if (active && !dense) {
          ctx.shadowBlur = 14;
          ctx.shadowColor = color;
        }
        ctx.fillStyle = dense ? withAlpha(color, 0.42) : color;
        ctx.fillRect(x, top, noteWidth, Math.max(dense ? 1 : 3, bottom - top));
        ctx.shadowBlur = 0;
        if (this.showLabels && !dense && noteWidth > 24 && bottom - top > 18) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, top, noteWidth, bottom - top);
          ctx.clip();
          ctx.fillStyle = 'rgba(0,0,0,.68)';
          ctx.font = '10px "Segoe UI", sans-serif';
          ctx.fillText(midiNoteName(note.pitch), x + 3, top + 12);
          ctx.restore();
        }
      }
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, playY);
    ctx.clip();
    drawNotes(false);
    drawNotes(true);
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#58e6ff';
    ctx.fillRect(0, playY, width, 2);
    ctx.shadowBlur = 0;
    if (this.showPiano) this._drawPiano(ctx, height, pianoLayout, playY + 3, activeKeyColors);
    this._drawHUD(ctx, width, time);
  }

  _drawWaterfallGrid(ctx, width, playY, time, secondsAhead) {
    const bpm = this.model.tempoAt(time);
    const beatSeconds = 60 / bpm;
    const signature = this.model.signatureAt(time);
    const firstBeat = Math.floor(time / beatSeconds);
    for (let beat = firstBeat; ; beat += 1) {
      const beatTime = beat * beatSeconds;
      const y = playY - (beatTime - time) / secondsAhead * playY;
      if (y < 0) break;
      if (y > playY) continue;
      const major = beat % signature.numerator === 0;
      ctx.strokeStyle = major ? 'rgba(120, 220, 255, .18)' : 'rgba(255,255,255,.06)';
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
      ctx.stroke();
    }
  }

  _drawPiano(ctx, height, layout, top, activeKeyColors = new Map()) {
    ctx.fillStyle = '#dce7ee';
    ctx.fillRect(0, top, layout.width, height - top);
    for (const key of layout.whiteKeys) {
      const activeColor = activePianoKeyColor(key.pitch, activeKeyColors, this.activeNotes);
      ctx.fillStyle = activeColor || ((key.pitch % 12 === 0) ? '#f8fcff' : '#e7eef3');
      ctx.fillRect(key.x + 0.5, top, Math.max(1, key.width - 1), height - top);
      ctx.strokeStyle = '#73808c';
      ctx.strokeRect(key.x + 0.5, top, Math.max(1, key.width - 1), height - top);
      if (layout.whiteKeyWidth > 25 && key.pitch % 12 === 0) {
        ctx.fillStyle = '#34434e';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(midiNoteName(key.pitch), key.center, height - 8);
      }
    }
    for (const key of layout.blackKeys) {
      ctx.fillStyle = activePianoKeyColor(key.pitch, activeKeyColors, this.activeNotes) || '#111923';
      ctx.fillRect(key.x, top, key.width, (height - top) * BLACK_KEY_HEIGHT_RATIO);
    }
    ctx.textAlign = 'left';
  }

  _drawRoll(ctx, width, height, time) {
    const range = this._range();
    const noteHeight = height / range.count;
    const secondsBefore = 3.5 / Math.sqrt(this.zoom);
    const secondsAfter = 8 / Math.sqrt(this.zoom);
    const visibleDuration = secondsBefore + secondsAfter;
    const playX = width * (secondsBefore / visibleDuration);

    for (let pitch = range.min; pitch <= range.max; pitch += 1) {
      const y = height - (pitch - range.min + 1) * noteHeight;
      ctx.fillStyle = isBlackPianoKey(pitch) ? 'rgba(255,255,255,.025)' : 'rgba(255,255,255,.052)';
      ctx.fillRect(0, y, width, noteHeight - 0.5);
      if (pitch % 12 === 0) {
        ctx.fillStyle = '#60758b';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText(midiNoteName(pitch), 5, y + Math.min(noteHeight - 2, 11));
      }
    }

    if (this.showGrid) {
      const bpm = this.model.tempoAt(time);
      const beatSeconds = 60 / bpm;
      const signature = this.model.signatureAt(time);
      const start = time - secondsBefore;
      const end = time + secondsAfter;
      for (let beat = Math.floor(start / beatSeconds); beat * beatSeconds <= end; beat += 1) {
        const beatTime = beat * beatSeconds;
        const x = (beatTime - start) / visibleDuration * width;
        ctx.strokeStyle = beat % signature.numerator === 0 ? 'rgba(88,230,255,.22)' : 'rgba(255,255,255,.07)';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
    }

    const notes = this.model.notesInRange(time - secondsBefore, time + secondsAfter, 30_000);
    const dense = notes.length > 10_000;
    for (const note of notes) {
      if (note.pitch < range.min || note.pitch > range.max || this._isMuted(note)) continue;
      const x = (note.start - (time - secondsBefore)) / visibleDuration * width;
      const w = Math.max(dense ? 1 : 3, note.duration / visibleDuration * width);
      const y = height - (note.pitch - range.min + 1) * noteHeight + 1;
      const color = this._noteColor(note);
      ctx.fillStyle = dense ? withAlpha(color, 0.48) : color;
      ctx.fillRect(x, y, w, Math.max(1, noteHeight - 2));
    }
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 12; ctx.shadowColor = '#58e6ff';
    ctx.fillRect(playX, 0, 2, height);
    ctx.shadowBlur = 0;
    this._drawHUD(ctx, width, time);
  }

  _drawStaff(ctx, width, height, time) {
    const margin = 58;
    const staffGap = Math.min(13, height / 24);
    const trebleCenter = height * 0.31;
    const bassCenter = height * 0.69;
    const secondsAhead = clamp(10 / Math.sqrt(this.zoom), 2, 18);
    ctx.fillStyle = '#f3f0e7';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#25303b';
    ctx.lineWidth = 1;
    for (const center of [trebleCenter, bassCenter]) {
      for (let line = -2; line <= 2; line += 1) {
        const y = center + line * staffGap;
        ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(width - 16, y); ctx.stroke();
      }
    }
    ctx.fillStyle = '#1f2a34';
    ctx.font = `${staffGap * 5.2}px "Segoe UI Symbol", "Noto Music", serif`;
    ctx.fillText('𝄞', 12, trebleCenter + staffGap * 2.2);
    ctx.font = `${staffGap * 4.3}px "Segoe UI Symbol", "Noto Music", serif`;
    ctx.fillText('𝄢', 16, bassCenter + staffGap * 1.6);

    const notes = this.model.notesInRange(time, time + secondsAhead, 5000);
    for (const note of notes) {
      if (this._isMuted(note)) continue;
      const x = margin + (note.start - time) / secondsAhead * (width - margin - 26);
      const useTreble = note.pitch >= 60;
      const center = useTreble ? trebleCenter : bassCenter;
      const reference = useTreble ? 71 : 50;
      const y = center - (note.pitch - reference) * (staffGap / 3.4);
      const color = this._noteColor(note);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.22);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(4, staffGap * 0.58), Math.max(3, staffGap * 0.38), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + staffGap * 0.5, y); ctx.lineTo(x + staffGap * 0.5, y - staffGap * 2.8); ctx.stroke();
    }

    const bpm = this.model.tempoAt(time);
    const beatSeconds = 60 / bpm;
    const signature = this.model.signatureAt(time);
    for (let beat = Math.ceil(time / beatSeconds); beat * beatSeconds <= time + secondsAhead; beat += 1) {
      if (beat % signature.numerator !== 0) continue;
      const x = margin + (beat * beatSeconds - time) / secondsAhead * (width - margin - 26);
      ctx.strokeStyle = 'rgba(30,40,50,.45)';
      ctx.beginPath(); ctx.moveTo(x, trebleCenter - staffGap * 2); ctx.lineTo(x, trebleCenter + staffGap * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, bassCenter - staffGap * 2); ctx.lineTo(x, bassCenter + staffGap * 2); ctx.stroke();
    }

    const chord = chordAt(this.analysis, time);
    ctx.fillStyle = '#18222c';
    ctx.font = '700 22px "Segoe UI", sans-serif';
    ctx.fillText(chord?.name || '', margin, 29);
    ctx.fillStyle = '#506171';
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillText(`${this.model.signatureAt(time).numerator}/${this.model.signatureAt(time).denominator}  ·  ${Math.round(bpm)} BPM`, width - 150, 26);
  }

  _drawSpectrum(ctx, width, height, time) {
    const classic = this.spectrumTheme === 'classic';
    const ice = this.spectrumTheme === 'ice';
    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, classic ? '#020703' : '#03030d');
    background.addColorStop(0.55, ice ? '#05051a' : '#020609');
    background.addColorStop(1, '#000');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = classic ? '#36ff70' : '#48dfff';
    ctx.lineWidth = 1;
    for (let y = 56; y < height; y += 18) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); ctx.stroke();
    }
    for (let x = 0; x < width; x += 48) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 54); ctx.lineTo(x + 0.5, height); ctx.stroke();
    }
    ctx.restore();

    const bands = aggregateSpectrumBands(this.spectrumData, 64);
    const headerHeight = Math.max(50, Math.min(72, height * 0.15));
    const footerHeight = Math.max(36, Math.min(58, height * 0.12));
    const baseline = height - footerHeight;
    const usableHeight = Math.max(80, baseline - headerHeight - 8);
    const gap = width > 900 ? 3 : 2;
    const barWidth = Math.max(2, (width - gap * 65) / 64);
    const left = Math.max(0, (width - (barWidth + gap) * 64 + gap) / 2);

    const colorAt = (band, ratio) => {
      if (this.spectrumTheme === 'rainbow') return `hsl(${(band / 64 * 300 + ratio * 55) % 360} 96% ${48 + ratio * 12}%)`;
      if (ice) return ratio > 0.82 ? '#ff58ec' : ratio > 0.5 ? '#866cff' : '#35e9ff';
      return ratio > 0.82 ? '#ff334f' : ratio > 0.56 ? '#ffe640' : '#32f46b';
    };

    for (let band = 0; band < 64; band += 1) {
      const boosted = Math.min(1, bands[band] * Math.max(0.5, Number(this.spectrumGain) || 1) * 1.35);
      const previous = this.spectrumLevels[band];
      const level = boosted > previous ? boosted : previous * 0.87;
      this.spectrumLevels[band] = level;
      this.spectrumPeaks[band] = Math.max(level, this.spectrumPeaks[band] - 0.012);
      const x = left + band * (barWidth + gap);
      const barHeight = level * usableHeight;
      const segmentHeight = Math.max(3, Math.min(7, usableHeight / 34));
      for (let y = 0; y < barHeight; y += segmentHeight + 2) {
        const ratio = y / usableHeight;
        ctx.fillStyle = colorAt(band, ratio);
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = level > 0.55 ? 5 : 0;
        ctx.fillRect(x, baseline - y - segmentHeight, barWidth, segmentHeight);
      }
      ctx.shadowBlur = 0;
      const peakY = baseline - this.spectrumPeaks[band] * usableHeight;
      ctx.fillStyle = colorAt(band, this.spectrumPeaks[band]);
      ctx.fillRect(x, peakY - 2, barWidth, 2);

      ctx.globalAlpha = 0.18;
      ctx.fillStyle = colorAt(band, 0.15);
      ctx.fillRect(x, baseline + 3, barWidth, Math.min(footerHeight - 8, barHeight * 0.18));
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = ice ? 'rgba(157,130,255,.72)' : 'rgba(88,230,255,.68)';
    ctx.lineWidth = 1.4;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 7;
    ctx.beginPath();
    for (let index = 0; index < this.waveformData.length; index += 1) {
      const x = index / Math.max(1, this.waveformData.length - 1) * width;
      const normalized = (this.waveformData[index] - 128) / 128;
      const y = headerHeight + usableHeight * 0.48 + normalized * usableHeight * 0.18;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = classic ? '#73ff91' : '#78eaff';
    ctx.font = `700 ${Math.max(12, Math.min(17, width / 80))}px Consolas, monospace`;
    ctx.fillText('MIDI VOYAGER // LIVE SPECTRUM', 16, 24);
    ctx.fillStyle = classic ? '#b8ffbf' : '#c7f8ff';
    ctx.font = `${Math.max(10, Math.min(13, width / 105))}px Consolas, monospace`;
    const title = String(this.model?.fileName || 'NO SIGNAL').replace(/\.(mid|midi|kar|rmi|rmid|xmf)$/i, '').toUpperCase();
    ctx.fillText(`▶ ${title.slice(0, Math.max(18, Math.floor(width / 12)))}`, 16, 45);
    ctx.textAlign = 'right';
    const bpm = this.model ? Math.round(this.model.tempoAt(time)) : 0;
    ctx.fillText(`${formatTime(time)}  |  ${bpm || '---'} BPM  |  64-BAND`, width - 16, 45);
    ctx.textAlign = 'left';

    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#fff';
    for (let y = 1; y < height; y += 3) ctx.fillRect(0, y, width, 1);
    ctx.globalAlpha = 1;
  }

  _drawHUD(ctx, width, time) {
    const signature = this.model.signatureAt(time);
    const key = this.model.keyAt(time)?.name || this.analysis?.key?.name || 'Key —';
    ctx.fillStyle = 'rgba(5,9,16,.74)';
    ctx.fillRect(10, 10, 218, 32);
    ctx.fillStyle = '#d8f7ff';
    ctx.font = '600 12px "Segoe UI", sans-serif';
    ctx.fillText(`${signature.numerator}/${signature.denominator}  ·  ${Math.round(this.model.tempoAt(time))} BPM  ·  ${key}`, 20, 31);
    const chord = chordAt(this.analysis, time);
    if (chord && chord.name !== '—') {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(5,9,16,.74)';
      ctx.fillRect(width - 100, 10, 90, 42);
      ctx.fillStyle = '#fff';
      ctx.font = '700 22px "Segoe UI", sans-serif';
      ctx.fillText(chord.name, width - 20, 39);
      ctx.textAlign = 'left';
    }
  }

  _renderOverlay(time, force) {
    if (!this.model) {
      this.overlay.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'overlay-empty';
      empty.textContent = 'Open a MIDI or KAR file to use this view.';
      this.overlay.append(empty);
      return;
    }
    if (this.view === 'karaoke') this._renderKaraoke(time, force);
    else this._renderEvents(time, force);
  }

  _renderKaraoke(time, force) {
    const lyric = this.model.lyricAt(time);
    const chord = chordAt(this.analysis, time);
    const key = `karaoke:${lyric.index}:${chord?.startTime ?? -1}`;
    if (!force && key === this.lastOverlayKey) return;
    this.lastOverlayKey = key;
    this.overlay.replaceChildren();
    const stage = document.createElement('div');
    stage.className = 'karaoke-stage';
    const chordLabel = document.createElement('div');
    chordLabel.className = 'karaoke-chord';
    chordLabel.textContent = chord?.name && chord.name !== '—' ? chord.name : '';
    const previous = document.createElement('div');
    previous.className = 'karaoke-line previous';
    previous.textContent = lyric.previous?.text || '';
    const current = document.createElement('div');
    current.className = 'karaoke-line current';
    current.textContent = lyric.current?.text || (this.model.lyrics.length ? '♪' : 'No lyrics in this file');
    const next = document.createElement('div');
    next.className = 'karaoke-line next';
    next.textContent = lyric.next?.text || '';
    stage.append(chordLabel, previous, current, next);
    this.overlay.append(stage);
  }

  _renderEvents(time, force) {
    const rounded = Math.floor(time * 4);
    const key = `events:${rounded}`;
    if (!force && key === this.lastOverlayKey) return;
    this.lastOverlayKey = key;
    this.overlay.replaceChildren();
    const list = document.createElement('div');
    list.className = 'event-list';
    for (const event of this.model.eventWindow(time, 55)) {
      const row = document.createElement('div');
      row.className = `event-row ${Math.abs(event.time - time) < 0.05 ? 'current' : ''}`;
      const stamp = document.createElement('span');
      stamp.className = 'event-time';
      stamp.textContent = formatTime(event.time);
      const track = document.createElement('span');
      track.className = 'event-track';
      track.textContent = this.model.tracks[event.track]?.name || `Track ${event.track + 1}`;
      const description = document.createElement('span');
      description.className = 'event-description';
      description.textContent = event.description;
      row.append(stamp, track, description);
      list.append(row);
    }
    this.overlay.append(list);
    const current = list.querySelector('.current');
    if (current) current.scrollIntoView({ block: 'center' });
  }

  pianoNoteAt(clientX, clientY) {
    if (this.view !== 'waterfall' || !this.showPiano) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const pianoTop = rect.height - PIANO_AREA_HEIGHT + 3;
    if (y < pianoTop) return null;
    const range = this._range();
    const layout = createPianoLayout(range.min, range.max, rect.width);
    return pianoPitchAt(layout, x, y - pianoTop, rect.height - pianoTop);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}
