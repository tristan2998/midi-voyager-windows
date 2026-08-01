'use strict';

const path = require('node:path');

const MIDI_FILE_EXTENSIONS = new Set(['.mid', '.midi', '.kar', '.rmi', '.rmid', '.xmf']);

function launchFilePaths(args = []) {
  const unique = new Set();
  for (const value of args) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const absolute = path.resolve(value);
    if (MIDI_FILE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) unique.add(absolute);
  }
  return [...unique];
}

function encodeOpenRequest(paths = []) {
  return `${JSON.stringify({ type: 'open-files', paths: launchFilePaths(paths), focus: true })}\n`;
}

function decodeOpenRequest(line) {
  const message = JSON.parse(String(line || ''));
  if (!message || message.type !== 'open-files') throw new Error('Unsupported application request.');
  return { paths: launchFilePaths(message.paths), focus: message.focus !== false };
}

module.exports = { MIDI_FILE_EXTENSIONS, launchFilePaths, encodeOpenRequest, decodeOpenRequest };
