import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('desktop UI and native host retain the required integration points', async () => {
  const [html, app, host, visualizer, installer, launcher] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../host/host.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/visualizer.js', import.meta.url), 'utf8'),
    readFile(new URL('../packaging/install.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../packaging/launcher.S', import.meta.url), 'utf8')
  ]);
  for (const id of [
    'open-midi', 'view-switcher', 'mixer-list', 'lyrics-list', 'export-wav',
    'soundfont-file-input', 'enable-all-soundfonts', 'repair-button', 'repair-dialog',
    'spectrum-theme-setting', 'spectrum-gain-setting'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /app\.js\?v=1\.2\.0/);
  assert.match(html, /assets\/icon\.png/);
  assert.match(app, /new AudioEngine/);
  assert.match(app, /createDemoMIDI/);
  assert.match(app, /bank-drag-handle/);
  assert.match(app, /setSoundBankEnabled/);
  assert.match(app, /toggleSoundBankSolo/);
  assert.match(app, /auditionSoundBank/);
  assert.match(app, /repairMIDI/);
  assert.match(app, /state\.view === 'spectrum'/);
  assert.match(visualizer, /activeKeyColors/);
  assert.match(visualizer, /_drawSpectrum/);
  assert.match(visualizer, /ctx\.rect\(0, 0, width, playY\)/);
  assert.match(host, /registerProtocol\('app'/);
  assert.match(host, /openFileDialog/);
  assert.match(host, /readFileChunk/);
  assert.match(host, /MAX_READ_CHUNK_BYTES/);
  assert.match(host, /__userfile/);
  assert.match(host, /revalidatedUIExtensions/);
  assert.match(host, /windowsDragAndDrop: true/);
  assert.match(host, /readyForFileOpen/);
  assert.match(host, /claimApplicationInstance/);
  assert.match(launcher, /GetCommandLineW/);
  for (const extension of ['mid', 'midi', 'kar', 'rmi', 'rmid', 'xmf']) assert.match(installer, new RegExp(`\\.${extension}`));
  assert.match(installer, /OpenWithProgids/);
  assert.match(installer, /RegisteredApplications/);
  assert.match(installer, /CurrentVersion\\Uninstall/);
  assert.match(installer, /ExpectedPayloadLength/);
  assert.match(installer, /ExpectedPayloadSha256/);
  assert.match(installer, /setup download is incomplete/);
  assert.match(installer, /Flush\(\$true\)/);
});
