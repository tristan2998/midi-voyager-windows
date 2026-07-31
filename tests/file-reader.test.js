import test from 'node:test';
import assert from 'node:assert/strict';
import { readDescriptor, readNativeDescriptor } from '../src/file-reader.js';

function chunkBridge(bytes) {
  const calls = [];
  return {
    calls,
    async readFileChunk(token, offset, requested) {
      calls.push({ token, offset, requested });
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + requested));
      return {
        data: Buffer.from(chunk).toString('base64'),
        bytesRead: chunk.byteLength,
        size: bytes.byteLength
      };
    }
  };
}

test('native file reader reconstructs MIDI and SoundFont-sized data across chunks', async () => {
  const source = Uint8Array.from({ length: 29 }, (_, index) => (index * 37) & 0xff);
  const bridge = chunkBridge(source);
  const progress = [];
  const result = await readNativeDescriptor(
    { name: 'bank.sf2', token: 'bank-token', size: source.byteLength },
    bridge,
    { chunkSize: 7, onProgress: ({ loaded }) => progress.push(loaded) }
  );

  assert.deepEqual(new Uint8Array(result), source);
  assert.deepEqual(bridge.calls.map(({ offset }) => offset), [0, 7, 14, 21, 28]);
  assert.deepEqual(progress, [7, 14, 21, 28, 29]);
});

test('saved file paths are reopened and read through the native bridge without fetch', async () => {
  const source = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);
  const reader = chunkBridge(source);
  const bridge = {
    ...reader,
    async openKnownFile(filePath) {
      assert.equal(filePath, 'C:\\Music\\song.mid');
      return { name: 'song.mid', path: filePath, size: source.byteLength, token: 'midi-token' };
    }
  };

  const result = await readDescriptor({ name: 'song.mid', path: 'C:\\Music\\song.mid', size: source.byteLength }, bridge, { chunkSize: 3 });
  assert.deepEqual(new Uint8Array(result), source);
  assert.equal(reader.calls.length, 3);
});

test('native file reader rejects truncated transfers', async () => {
  const bridge = {
    async readFileChunk() {
      return { data: '', bytesRead: 0, size: 12 };
    }
  };
  await assert.rejects(
    readNativeDescriptor({ name: 'broken.mid', token: 'broken', size: 12 }, bridge, { chunkSize: 4 }),
    /stopped before the file was complete/
  );
});
