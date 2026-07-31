import { build as bundle } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';
import * as PELibrary from 'pe-library';
import * as ResEdit from 'resedit';
import { deflateSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(root, 'build');
const uiBuild = join(buildRoot, 'ui');
const releaseRoot = join(root, 'release');
const portableName = 'MIDI Voyager Windows';
const portableRoot = join(releaseRoot, portableName);
const appVersion = '1.0.1';
const portableZipName = `${portableName} ${appVersion} x64.zip`;
const sourceZipName = `${portableName} Source ${appVersion}.zip`;
const sourceFolderName = `${portableName} Source`;
const vendorPackRoot = resolve(root, '..', 'vendor_packs');

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}

function makePng(width, height, rgba) {
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const output = y * (width * 4 + 1);
    scanlines[output] = 0;
    rgba.copy(scanlines, output + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIconPixels(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bars = [
    { x: 0.22, top: 0.56, color: [77, 225, 255] },
    { x: 0.37, top: 0.37, color: [88, 231, 255] },
    { x: 0.52, top: 0.21, color: [130, 206, 255] },
    { x: 0.67, top: 0.46, color: [207, 125, 255] }
  ];
  const radius = size * 0.21;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const cx = Math.max(radius, Math.min(size - radius, x + 0.5));
      const cy = Math.max(radius, Math.min(size - radius, y + 0.5));
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius - 0.7;
      if (!inside) continue;
      const t = y / Math.max(1, size - 1);
      rgba[index] = Math.round(7 + t * 8);
      rgba[index + 1] = Math.round(19 + t * 24);
      rgba[index + 2] = Math.round(33 + t * 35);
      rgba[index + 3] = 255;
      const edgeDistance = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edgeDistance < Math.max(1, size * 0.025)) {
        rgba[index] = 30; rgba[index + 1] = 91; rgba[index + 2] = 118;
      }
      for (const bar of bars) {
        const halfWidth = size * 0.044;
        if (Math.abs(x + 0.5 - size * bar.x) <= halfWidth && y + 0.5 >= size * bar.top && y + 0.5 <= size * 0.79) {
          const glow = 0.78 + 0.22 * (1 - (y / size - bar.top) / Math.max(0.01, 0.79 - bar.top));
          rgba[index] = Math.round(bar.color[0] * glow);
          rgba[index + 1] = Math.round(bar.color[1] * glow);
          rgba[index + 2] = Math.round(bar.color[2] * glow);
        }
      }
    }
  }
  return rgba;
}

async function createIcons(assetRoot) {
  await mkdir(assetRoot, { recursive: true });
  const iconFile = new ResEdit.Data.IconFile();
  let raw64;
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const rgba = makeIconPixels(size);
    const png = makePng(size, size, rgba);
    if (size === 64) {
      raw64 = rgba;
      await writeFile(join(assetRoot, 'icon.png'), png);
    }
    iconFile.icons.push({
      width: size, height: size, colors: 0, planes: 1, bitCount: 32,
      data: ResEdit.Data.RawIconItem.from(png, size, size, 32)
    });
  }
  const ico = Buffer.from(iconFile.generate());
  await writeFile(join(assetRoot, 'icon.ico'), ico);
  await writeFile(join(assetRoot, 'icon.rgba'), raw64);
  return ico;
}

async function buildLauncher() {
  const launcherRoot = join(buildRoot, 'launcher');
  const importRoot = join(buildRoot, 'importlibs');
  const executable = join(launcherRoot, `${portableName}.exe`);
  await mkdir(launcherRoot, { recursive: true });
  await mkdir(importRoot, { recursive: true });

  if (commandExists('as') && commandExists('ld')) {
    const stubsObject = join(importRoot, 'import-stubs.o');
    const kernelLibrary = join(importRoot, 'libkernel32.a');
    const userLibrary = join(importRoot, 'libuser32.a');
    run('as', ['--64', join(root, 'packaging', 'import-stubs.S'), '-o', stubsObject]);
    run('ld', ['-mi386pep', '--dll', '--out-implib', kernelLibrary, '-o', join(importRoot, 'kernel32-stub.dll'), stubsObject, join(root, 'packaging', 'kernel32.def')]);
    run('ld', ['-mi386pep', '--dll', '--out-implib', userLibrary, '-o', join(importRoot, 'user32-stub.dll'), stubsObject, join(root, 'packaging', 'user32.def')]);
    const launcherObject = join(launcherRoot, 'launcher.o');
    run('as', ['--64', join(root, 'packaging', 'launcher.S'), '-o', launcherObject]);
    run('ld', [
      '-mi386pep', '--image-base', '0x140000000', '--subsystem', 'windows', '--entry', 'WinMainCRTStartup',
      '--stack', '1048576,4096', '--dynamicbase', '--high-entropy-va', '--nxcompat', '--strip-all', '-o', executable,
      launcherObject, kernelLibrary, userLibrary
    ]);
  } else {
    const prebuilt = join(root, 'packaging', 'prebuilt', `${portableName}.exe`);
    if (!(await exists(prebuilt))) throw new Error('GNU as/ld are unavailable and the prebuilt launcher is missing.');
    await copyFile(prebuilt, executable);
  }
  return executable;
}

async function addExecutableResources(executablePath, ico) {
  const executable = PELibrary.NtExecutable.from(await readFile(executablePath));
  const resources = PELibrary.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(ico);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries, 101, 1033, iconFile.icons.map((item) => item.data)
  );
  const [major = 0, minor = 0, patch = 0, revision = 0] = appVersion.split('.').map((value) => Number(value) || 0);
  const versionMS = ((major << 16) | minor) >>> 0;
  const versionLS = ((patch << 16) | revision) >>> 0;
  const version = ResEdit.Resource.VersionInfo.create({
    lang: 1033,
    fixedInfo: {
      fileVersionMS: versionMS, fileVersionLS: versionLS,
      productVersionMS: versionMS, productVersionLS: versionLS,
      fileFlagsMask: 0x3f, fileFlags: 0, fileOS: 0x00040004, fileType: 1
    },
    strings: [{
      lang: 1033, codepage: 1200,
      values: {
        CompanyName: 'MIDI Voyager',
        FileDescription: 'MIDI Voyager Windows',
        FileVersion: appVersion,
        InternalName: 'MidiVoyagerWindows',
        OriginalFilename: `${portableName}.exe`,
        ProductName: portableName,
        ProductVersion: appVersion
      }
    }]
  });
  version.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
  const prebuiltRoot = join(root, 'packaging', 'prebuilt');
  await mkdir(prebuiltRoot, { recursive: true });
  await copyFile(executablePath, join(prebuiltRoot, `${portableName}.exe`));
}

async function findVendorFile(modulePath, tarballName, archivePath) {
  if (await exists(modulePath)) return modulePath;
  const tarball = join(vendorPackRoot, tarballName);
  if (!(await exists(tarball))) throw new Error(`Missing Windows runtime package: ${tarballName}. Run npm install on Windows or download the optional package.`);
  const extractRoot = join(buildRoot, 'vendor', tarballName.replace(/\.tgz$/, ''));
  await mkdir(extractRoot, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extractRoot]);
  const extracted = join(extractRoot, 'package', archivePath);
  if (!(await exists(extracted))) throw new Error(`Runtime package did not contain ${archivePath}.`);
  return extracted;
}

async function copyLicences() {
  const licences = join(portableRoot, 'Licences');
  await mkdir(licences, { recursive: true });
  const copies = [
    ['node_modules/spessasynth_core/LICENSE', 'SpessaSynth-Core-Apache-2.0.txt'],
    ['node_modules/spessasynth_lib/LICENSE', 'SpessaSynth-Library-Apache-2.0.txt'],
    ['node_modules/midi-file/LICENSE.md', 'midi-file-MIT.txt'],
    ['node_modules/@webviewjs/webview/LICENSE', 'WebViewJS-MIT.txt'],
    ['node_modules/generaluser/LICENSE.txt', 'GeneralUser-GS-LICENSE.txt']
  ];
  for (const [source, target] of copies) await copyFile(join(root, source), join(licences, target));
  const nodeLicense = `Node.js is licensed for use as follows:\n\nCopyright Node.js contributors. All rights reserved.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\nNode.js includes other components under compatible licences. Full upstream notices for v24.18.1: https://github.com/nodejs/node/blob/v24.18.1/LICENSE\n`;
  await writeFile(join(licences, 'Node.js-LICENSE.txt'), nodeLicense);
}

async function stagePortable(launcher) {
  await mkdir(portableRoot, { recursive: true });
  await copyFile(launcher, join(portableRoot, `${portableName}.exe`));
  await mkdir(join(portableRoot, 'app'), { recursive: true });
  await copyFile(join(root, 'host', 'host.cjs'), join(portableRoot, 'app', 'host.cjs'));
  await cp(uiBuild, join(portableRoot, 'ui'), { recursive: true });
  await copyFile(join(root, 'README-Windows.txt'), join(portableRoot, 'README.txt'));
  await copyFile(join(root, 'THIRD-PARTY-NOTICES.txt'), join(portableRoot, 'THIRD-PARTY-NOTICES.txt'));
  await copyLicences();

  const runtimeRoot = join(portableRoot, 'runtime');
  const webviewRoot = join(runtimeRoot, 'webview');
  await mkdir(webviewRoot, { recursive: true });
  const nodeExecutable = await findVendorFile(
    join(root, 'node_modules', 'node-win-x64', 'bin', 'node.exe'),
    'node-win-x64-24.18.1.tgz', 'bin/node.exe'
  );
  const nativeBinding = await findVendorFile(
    join(root, 'node_modules', '@webviewjs', 'webview-win32-x64-msvc', 'webview.win32-x64-msvc.node'),
    'webviewjs-webview-win32-x64-msvc-0.4.1.tgz', 'webview.win32-x64-msvc.node'
  );
  await copyFile(nodeExecutable, join(runtimeRoot, 'node.exe'));
  await copyFile(nativeBinding, join(webviewRoot, 'webview.win32-x64-msvc.node'));
  for (const file of ['index.js', 'js-bindings.js', 'package.json']) {
    await copyFile(join(root, 'node_modules', '@webviewjs', 'webview', file), join(webviewRoot, file));
  }
}

async function stageSource() {
  const sourceStageRoot = join(buildRoot, 'source');
  const sourceRoot = join(sourceStageRoot, sourceFolderName);
  await mkdir(sourceRoot, { recursive: true });
  for (const file of ['.gitignore', 'package.json', 'package-lock.json', 'README.md', 'README-Windows.txt', 'THIRD-PARTY-NOTICES.txt']) {
    await copyFile(join(root, file), join(sourceRoot, file));
  }
  for (const directory of ['src', 'host', 'packaging', 'scripts', 'tests']) {
    await cp(join(root, directory), join(sourceRoot, directory), { recursive: true });
  }
  return { sourceStageRoot, sourceRoot };
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function collectZipFiles(directory, prefix, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const archivePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collectZipFiles(absolute, `${archivePath}/`, output);
    else if (entry.isFile()) output[archivePath] = new Uint8Array(await readFile(absolute));
  }
}

async function createZip(parentDirectory, folderName, outputPath) {
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0) {
    run('zip', ['-9', '-q', '-r', outputPath, folderName], { cwd: parentDirectory });
    return;
  }
  const files = {};
  await collectZipFiles(join(parentDirectory, folderName), `${folderName}/`, files);
  await writeFile(outputPath, Buffer.from(zipSync(files, { level: 9 })));
}

async function verifyZip(filePath) {
  if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0) {
    run('unzip', ['-tqq', filePath]);
    return;
  }
  const files = unzipSync(new Uint8Array(await readFile(filePath)));
  if (!Object.keys(files).length) throw new Error(`Archive is empty: ${filePath}`);
}

async function main() {
  await rm(buildRoot, { recursive: true, force: true });
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(uiBuild, { recursive: true });
  await mkdir(releaseRoot, { recursive: true });

  await bundle({
    entryPoints: [join(root, 'src', 'app.js')],
    outfile: join(uiBuild, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome110',
    minify: true,
    treeShaking: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' }
  });
  await copyFile(join(root, 'src', 'index.html'), join(uiBuild, 'index.html'));
  await copyFile(join(root, 'src', 'styles.css'), join(uiBuild, 'styles.css'));
  const assetRoot = join(uiBuild, 'assets');
  await mkdir(assetRoot, { recursive: true });
  await copyFile(join(root, 'node_modules', 'spessasynth_lib', 'dist', 'spessasynth_processor.min.js'), join(assetRoot, 'spessasynth_processor.min.js'));
  await copyFile(join(root, 'node_modules', 'generaluser', 'GeneralUser.sf2'), join(assetRoot, 'GeneralUser.sf2'));
  const ico = await createIcons(assetRoot);
  const launcher = await buildLauncher();
  await addExecutableResources(launcher, ico);
  await stagePortable(launcher);
  const { sourceStageRoot } = await stageSource();

  const portableZip = join(releaseRoot, portableZipName);
  const sourceZip = join(releaseRoot, sourceZipName);
  await createZip(releaseRoot, portableName, portableZip);
  await createZip(sourceStageRoot, sourceFolderName, sourceZip);
  await verifyZip(portableZip);
  await verifyZip(sourceZip);
  const portableStats = await stat(portableZip);
  const sourceStats = await stat(sourceZip);
  const checksums = `${await sha256(portableZip)}  ${portableZipName}\n${await sha256(sourceZip)}  ${sourceZipName}\n`;
  await writeFile(join(releaseRoot, 'SHA256SUMS.txt'), checksums);

  const files = await readdir(portableRoot, { withFileTypes: true });
  console.log(`Built ${portableZipName} (${(portableStats.size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`Built ${sourceZipName} (${(sourceStats.size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`Portable root entries: ${files.map((item) => item.name).join(', ')}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
