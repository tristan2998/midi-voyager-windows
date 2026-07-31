export const NATIVE_READ_CHUNK_BYTES = 1024 * 1024;

function validSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function decodeBase64(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function readNativeDescriptor(descriptor, bridge, options = {}) {
  if (!descriptor?.token) throw new Error('The selected file has no native access token.');
  if (typeof bridge?.readFileChunk !== 'function') throw new Error('Native file reading is unavailable.');

  const chunkSize = Number(options.chunkSize) || NATIVE_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > NATIVE_READ_CHUNK_BYTES) {
    throw new Error('The native file chunk size is invalid.');
  }

  let total = validSize(descriptor.size);
  let output = total === null ? null : new Uint8Array(total);
  let offset = 0;

  do {
    const requested = total === null ? chunkSize : Math.min(chunkSize, total - offset);
    if (requested === 0) break;

    const result = await bridge.readFileChunk(descriptor.token, offset, requested);
    const currentSize = validSize(result?.size);
    if (currentSize === null) throw new Error(`Could not determine the size of ${descriptor.name || 'the selected file'}.`);
    if (total === null) {
      total = currentSize;
      output = new Uint8Array(total);
    } else if (currentSize !== total) {
      throw new Error(`${descriptor.name || 'The selected file'} changed while it was being read. Please open it again.`);
    }

    const chunk = decodeBase64(result?.data);
    if (chunk.byteLength !== Number(result?.bytesRead) || chunk.byteLength > requested || offset + chunk.byteLength > total) {
      throw new Error(`Received invalid file data while reading ${descriptor.name || 'the selected file'}.`);
    }
    if (!chunk.byteLength && offset < total) {
      throw new Error(`Reading ${descriptor.name || 'the selected file'} stopped before the file was complete.`);
    }

    output.set(chunk, offset);
    offset += chunk.byteLength;
    options.onProgress?.({ loaded: offset, total });
  } while (offset < total);

  if (!output || offset !== total) {
    throw new Error(`Reading ${descriptor.name || 'the selected file'} stopped before the file was complete.`);
  }
  return output.buffer;
}

async function fetchDescriptor(descriptor) {
  const response = await fetch(descriptor.url);
  if (!response.ok) throw new Error(`Could not read ${descriptor.name} (${response.status}).`);
  return response.arrayBuffer();
}

export async function readDescriptor(descriptor, bridge = globalThis.window?.native, options = {}) {
  if (descriptor?.file && typeof descriptor.file.arrayBuffer === 'function') return descriptor.file.arrayBuffer();
  if (descriptor?.token && typeof bridge?.readFileChunk === 'function') {
    return readNativeDescriptor(descriptor, bridge, options);
  }
  if (descriptor?.path && typeof bridge?.openKnownFile === 'function') {
    const opened = await bridge.openKnownFile(descriptor.path);
    if (!opened) throw new Error('The file is no longer available at its saved location.');
    Object.assign(descriptor, opened, { path: opened.path || descriptor.path });
    if (descriptor.token && typeof bridge.readFileChunk === 'function') {
      return readNativeDescriptor(descriptor, bridge, options);
    }
    if (descriptor.url) return fetchDescriptor(descriptor);
    throw new Error('The desktop host could not provide access to the selected file.');
  }
  if (descriptor?.url) return fetchDescriptor(descriptor);
  throw new Error('This browser-opened file cannot be reopened automatically. Choose it again.');
}
