import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('desktop UI and native host retain the required integration points', async () => {
  const [html, app, host] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../host/host.cjs', import.meta.url), 'utf8')
  ]);
  for (const id of ['open-midi', 'view-switcher', 'mixer-list', 'lyrics-list', 'export-wav', 'soundfont-file-input']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /app\.js\?v=1\.0\.2/);
  assert.match(app, /new AudioEngine/);
  assert.match(app, /createDemoMIDI/);
  assert.match(host, /registerProtocol\('app'/);
  assert.match(host, /openFileDialog/);
  assert.match(host, /readFileChunk/);
  assert.match(host, /MAX_READ_CHUNK_BYTES/);
  assert.match(host, /__userfile/);
  assert.match(host, /revalidatedUIExtensions/);
  assert.match(host, /windowsDragAndDrop: true/);
});
