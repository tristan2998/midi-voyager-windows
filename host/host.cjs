'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_NAME = 'MIDI Voyager Windows';
const MAX_READ_CHUNK_BYTES = 1024 * 1024;
const appRoot = path.resolve(__dirname, '..');
let Application;
try {
  ({ Application } = require('../runtime/webview/index.js'));
} catch (error) {
  fs.writeFileSync(path.join(appRoot, 'startup-error.txt'), `${new Date().toISOString()}\n${error.stack || error}\n`);
  process.exit(1);
}
const uiRoot = path.join(appRoot, 'ui');
const allowedOpenExtensions = new Set(['.mid', '.midi', '.kar', '.rmi', '.rmid', '.xmf', '.sf2', '.sf3', '.dls', '.sf2pack']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.sf2': 'application/octet-stream', '.sf3': 'application/octet-stream', '.dls': 'application/octet-stream',
  '.mid': 'audio/midi', '.midi': 'audio/midi', '.kar': 'audio/midi', '.xmf': 'application/octet-stream'
};
const revalidatedUIExtensions = new Set(['.html', '.js', '.css']);

const fileTokens = new Map();
const saveSessions = new Map();
let mainWindow = null;
let mainWebview = null;
let mainWebContext = null;

function tokenForFile(filePath) {
  const absolute = path.resolve(filePath);
  const extension = path.extname(absolute).toLowerCase();
  if (!allowedOpenExtensions.has(extension)) throw new Error(`Unsupported file type: ${extension || '(none)'}`);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('The selected path is not a file.');
  const token = crypto.randomBytes(18).toString('hex');
  fileTokens.set(token, absolute);
  if (fileTokens.size > 512) fileTokens.delete(fileTokens.keys().next().value);
  return {
    name: path.basename(absolute),
    path: absolute,
    size: stat.size,
    token,
    url: `app://localhost/__userfile/${token}/${encodeURIComponent(path.basename(absolute))}`
  };
}

async function readFileChunk(token, offset, requestedLength) {
  const filePath = fileTokens.get(String(token || ''));
  if (!filePath) throw new Error('Access to this file has expired. Please open it again.');

  const start = Number(offset);
  const length = Number(requestedLength);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1) {
    throw new Error('The file read request was invalid.');
  }

  const handle = await fsp.open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error('The selected path is no longer a file.');
    if (start > fileStat.size) throw new Error('The file read started beyond the end of the file.');
    const bytesToRead = Math.min(length, MAX_READ_CHUNK_BYTES, fileStat.size - start);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = bytesToRead
      ? await handle.read(buffer, 0, bytesToRead, start)
      : { bytesRead: 0 };
    return {
      data: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      size: fileStat.size
    };
  } finally {
    await handle.close();
  }
}

function safeUIPath(urlString) {
  const url = new URL(urlString);
  const requested = decodeURIComponent(url.pathname || '/index.html').replace(/^[/\\]+/, '');
  const resolved = path.resolve(uiRoot, requested || 'index.html');
  if (resolved !== uiRoot && !resolved.startsWith(`${uiRoot}${path.sep}`)) throw new Error('Invalid UI path.');
  return resolved;
}

async function appProtocol(request) {
  try {
    const requestURL = new URL(request.url);
    const userFileMatch = requestURL.pathname.match(/^\/__userfile\/([a-f0-9]{36})(?:\/|$)/i);
    if (userFileMatch) return userFileResponse(userFileMatch[1]);
    const filePath = safeUIPath(request.url);
    const body = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    return new Response(body, {
      headers: {
        'Content-Type': mimeTypes[extension] || 'application/octet-stream',
        'Cache-Control': revalidatedUIExtensions.has(extension) ? 'no-cache' : 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return new Response(`Not found: ${error.message}`, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function userFileResponse(token) {
  try {
    const filePath = fileTokens.get(token);
    if (!filePath) throw new Error('This file token has expired.');
    const body = await fsp.readFile(filePath);
    return new Response(body, {
      headers: {
        'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return new Response(error.message, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function userFileProtocol(request) {
  return userFileResponse(new URL(request.url).hostname);
}

function sanitizeExportName(name) {
  const clean = path.basename(String(name || 'MIDI Voyager export'))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  return clean || 'MIDI Voyager export';
}

async function availablePath(directory, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(directory, fileName);
  let index = 2;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(directory, `${stem} (${index++})${extension}`);
    } catch {
      return candidate;
    }
  }
}

function exposeNativeBridge() {
  mainWebview.expose('native', {
    appName: APP_NAME,
    openMidiFiles: async (multiple) => {
      const paths = await mainWindow.openFileDialog({
        multiple: Boolean(multiple),
        title: multiple ? 'Open MIDI files' : 'Open a MIDI file',
        filters: [
          { name: 'MIDI and karaoke', extensions: ['mid', 'midi', 'kar', 'rmi', 'rmid', 'xmf'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      return paths.map(tokenForFile);
    },
    openSoundFontFiles: async () => {
      const paths = await mainWindow.openFileDialog({
        multiple: true,
        title: 'Add SoundFonts',
        filters: [
          { name: 'Sound banks', extensions: ['sf2', 'sf3', 'dls', 'sf2pack'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      return paths.map(tokenForFile);
    },
    openKnownFile: async (filePath) => tokenForFile(filePath),
    readFileChunk,
    beginSave: async (suggestedName, expectedSize) => {
      const exportsDirectory = path.join(os.homedir(), 'Music', 'MIDI Voyager Exports');
      await fsp.mkdir(exportsDirectory, { recursive: true });
      const finalPath = await availablePath(exportsDirectory, sanitizeExportName(suggestedName));
      const id = crypto.randomBytes(16).toString('hex');
      const temporaryPath = `${finalPath}.partial-${id}`;
      await fsp.writeFile(temporaryPath, Buffer.alloc(0));
      saveSessions.set(id, { finalPath, temporaryPath, expectedSize: Number(expectedSize) || 0, written: 0 });
      return { id };
    },
    appendSave: async (id, base64Chunk) => {
      const session = saveSessions.get(id);
      if (!session) throw new Error('The export session is no longer available.');
      const chunk = Buffer.from(base64Chunk, 'base64');
      await fsp.appendFile(session.temporaryPath, chunk);
      session.written += chunk.length;
      return { written: session.written };
    },
    finishSave: async (id) => {
      const session = saveSessions.get(id);
      if (!session) throw new Error('The export session is no longer available.');
      if (session.expectedSize && session.written !== session.expectedSize) {
        throw new Error(`Export was incomplete (${session.written} of ${session.expectedSize} bytes).`);
      }
      await fsp.rename(session.temporaryPath, session.finalPath);
      saveSessions.delete(id);
      return { path: session.finalPath, size: session.written };
    }
  });
}

async function start() {
  const app = new Application();
  await app.whenReady();
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const webviewData = path.join(localAppData, APP_NAME, 'WebView2');
  await fsp.mkdir(webviewData, { recursive: true });
  mainWebContext = app.createWebContext({ dataDirectory: webviewData });
  mainWindow = app.createBrowserWindow({
    title: APP_NAME,
    width: 1400,
    height: 860,
    logical: true,
    resizable: true,
    windowsDragAndDrop: true,
    windowsClassName: 'MidiVoyagerWindows'
  });
  mainWindow.setMinSize(840, 560, true);
  mainWindow.center();
  mainWindow.registerProtocol('app', appProtocol);
  mainWindow.registerProtocol('userfile', userFileProtocol);

  const iconPath = path.join(uiRoot, 'assets', 'icon.rgba');
  if (fs.existsSync(iconPath)) {
    const icon = fs.readFileSync(iconPath);
    mainWindow.setWindowIcon(icon, 64, 64);
    mainWindow.setTaskbarIcon(icon, 64, 64);
  }

  mainWebview = mainWindow.createWebview({
    url: 'app://localhost/index.html',
    webContext: mainWebContext,
    enableDevtools: false,
    navigationHandler: (url) => url.startsWith('app://') || url.startsWith('userfile://') || url === 'about:blank'
  });
  exposeNativeBridge();

  mainWindow.on('file-drop', ({ files }) => {
    const descriptors = [];
    for (const filePath of files || []) {
      try { descriptors.push(tokenForFile(filePath)); } catch { /* Ignore unsupported dropped files. */ }
    }
    if (descriptors.length) mainWebview.evaluateScript(`window.__onNativeDrop?.(${JSON.stringify(descriptors)});`);
  });
  app.on('application-close-requested', () => app.exit());
  app.on('window-close-requested', () => app.exit());
}

start().catch((error) => {
  fs.writeFileSync(path.join(appRoot, 'startup-error.txt'), `${new Date().toISOString()}\n${error.stack || error}\n`);
  process.exitCode = 1;
});
