import { build as bundle } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';
import * as PELibrary from 'pe-library';
import * as ResEdit from 'resedit';
import { gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access, appendFile, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(root, 'build');
const uiBuild = join(buildRoot, 'ui');
const releaseRoot = join(root, 'release');
const portableName = 'MIDI Voyager Windows';
const portableRoot = join(releaseRoot, portableName);
const appVersion = '1.1.1';
const portableZipName = `${portableName} ${appVersion} x64.zip`;
const installerName = `${portableName} Setup ${appVersion}.exe`;
const sourceZipName = `${portableName} Source ${appVersion}.zip`;
const sourceFolderName = `${portableName} Source`;
const vendorPackRoot = resolve(root, '..', 'vendor_packs');
const installerPayloadMarker = 'MIDI_VOYAGER_WINDOWS_PAYLOAD_7D25A16F_END';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

async function createIcons(assetRoot) {
  await mkdir(assetRoot, { recursive: true });
  const iconRoot = join(root, 'packaging');
  for (const file of ['icon.png', 'icon.ico', 'icon.rgba']) {
    await copyFile(join(iconRoot, file), join(assetRoot, file));
  }
  return readFile(join(iconRoot, 'icon.ico'));
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

async function addExecutableResources(executablePath, ico, metadata = {}) {
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
        FileDescription: metadata.fileDescription || portableName,
        FileVersion: appVersion,
        InternalName: metadata.internalName || 'MidiVoyagerWindows',
        OriginalFilename: metadata.originalFilename || `${portableName}.exe`,
        ProductName: metadata.productName || portableName,
        ProductVersion: appVersion
      }
    }]
  });
  version.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
  if (metadata.persistPrebuilt) {
    const prebuiltRoot = join(root, 'packaging', 'prebuilt');
    await mkdir(prebuiltRoot, { recursive: true });
    await copyFile(executablePath, join(prebuiltRoot, `${portableName}.exe`));
  }
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
  for (const file of ['host.cjs', 'open-with.cjs']) {
    await copyFile(join(root, 'host', file), join(portableRoot, 'app', file));
  }
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

function utf16Directives(value) {
  const bytes = Buffer.from(`${value}\0`, 'utf16le');
  const words = [];
  for (let offset = 0; offset < bytes.length; offset += 2) words.push(bytes.readUInt16LE(offset));
  const lines = [];
  for (let index = 0; index < words.length; index += 24) lines.push(`    .short ${words.slice(index, index + 24).join(',')}`);
  return lines.join('\n');
}

function installerLauncherAssembly(commandLine) {
  return `/* Generated x64 Windows setup launcher. */
    .section .text
    .global WinMainCRTStartup
WinMainCRTStartup:
    andq $-16, %rsp
    subq $0x80, %rsp

    xorl %ecx, %ecx
    leaq module_path(%rip), %rdx
    movl $32768, %r8d
    call *__imp_GetModuleFileNameW(%rip)
    testl %eax, %eax
    jz setup_error

    leaq setup_path_environment(%rip), %rcx
    leaq module_path(%rip), %rdx
    call *__imp_SetEnvironmentVariableW(%rip)
    testl %eax, %eax
    jz setup_error

    movl $104, startup_info(%rip)
    movq $0, 0x20(%rsp)
    movq $0x08000000, 0x28(%rsp)
    movq $0, 0x30(%rsp)
    movq $0, 0x38(%rsp)
    leaq startup_info(%rip), %rax
    movq %rax, 0x40(%rsp)
    leaq process_info(%rip), %rax
    movq %rax, 0x48(%rsp)
    xorq %rcx, %rcx
    leaq setup_command_line(%rip), %rdx
    xorq %r8, %r8
    xorq %r9, %r9
    call *__imp_CreateProcessW(%rip)
    testl %eax, %eax
    jz setup_error

    movq process_info+8(%rip), %rcx
    call *__imp_CloseHandle(%rip)
    movq process_info(%rip), %rcx
    movl $0xffffffff, %edx
    call *__imp_WaitForSingleObject(%rip)
    movq process_info(%rip), %rcx
    leaq child_exit_code(%rip), %rdx
    call *__imp_GetExitCodeProcess(%rip)
    movq process_info(%rip), %rcx
    call *__imp_CloseHandle(%rip)
    movl child_exit_code(%rip), %ecx
    testl %ecx, %ecx
    jnz setup_error
    xorl %ecx, %ecx
    call *__imp_ExitProcess(%rip)

setup_error:
    xorq %rcx, %rcx
    leaq error_message(%rip), %rdx
    leaq window_title(%rip), %r8
    movl $0x10, %r9d
    call *__imp_MessageBoxW(%rip)
    movl $1, %ecx
    call *__imp_ExitProcess(%rip)

    .section .data
    .align 2
setup_path_environment:
${utf16Directives('MIDI_VOYAGER_SETUP_PATH')}
window_title:
${utf16Directives(`${portableName} Setup`)}
error_message:
${utf16Directives('Setup could not start Windows PowerShell or did not finish successfully. Please run the installer again.')}
setup_command_line:
${utf16Directives(commandLine)}

    .section .bss
    .align 16
module_path:
    .skip 65536
startup_info:
    .skip 104
process_info:
    .skip 24
child_exit_code:
    .skip 4
`;
}

async function buildInstaller(ico) {
  const installerBuildRoot = join(buildRoot, 'installer');
  const importRoot = join(buildRoot, 'importlibs');
  const setupBase = join(installerBuildRoot, 'setup-base.exe');
  const setupSource = join(installerBuildRoot, 'setup.S');
  const setupObject = join(installerBuildRoot, 'setup.o');
  const prebuiltSetup = join(root, 'packaging', 'prebuilt', 'MIDI Voyager Windows Setup Stub.exe');
  await mkdir(installerBuildRoot, { recursive: true });

  const installTemplate = await readFile(join(root, 'packaging', 'install.ps1'), 'utf8');
  const installScript = installTemplate
    .replaceAll('__APP_VERSION__', appVersion)
    .replaceAll('__PAYLOAD_MARKER__', installerPayloadMarker);
  const compressedScript = gzipSync(Buffer.from(installScript, 'utf8'), { level: 9 }).toString('base64');
  const loader = `$b=[Convert]::FromBase64String('${compressedScript}');$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);Invoke-Expression ($r.ReadToEnd())`;
  const encodedLoader = Buffer.from(loader, 'utf16le').toString('base64');
  const commandLine = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedLoader}`;
  if (commandLine.length >= 32_000) throw new Error(`The setup command line is too long (${commandLine.length} characters).`);
  await writeFile(setupSource, installerLauncherAssembly(commandLine));

  if (commandExists('as') && commandExists('ld')) {
    run('as', ['--64', setupSource, '-o', setupObject]);
    run('ld', [
      '-mi386pep', '--image-base', '0x140000000', '--subsystem', 'windows', '--entry', 'WinMainCRTStartup',
      '--stack', '1048576,4096', '--dynamicbase', '--high-entropy-va', '--nxcompat', '--strip-all', '-o', setupBase,
      setupObject, join(importRoot, 'libkernel32.a'), join(importRoot, 'libuser32.a')
    ]);
  } else if (await exists(prebuiltSetup)) {
    await copyFile(prebuiltSetup, setupBase);
  } else {
    throw new Error('GNU as/ld are unavailable and the prebuilt installer launcher is missing.');
  }
  await addExecutableResources(setupBase, ico, {
    fileDescription: `${portableName} Installer`,
    internalName: 'MidiVoyagerWindowsSetup',
    originalFilename: installerName,
    productName: `${portableName} Setup`
  });
  await mkdir(join(root, 'packaging', 'prebuilt'), { recursive: true });
  await copyFile(setupBase, prebuiltSetup);

  const payloadRoot = join(installerBuildRoot, 'payload');
  const payloadZip = join(installerBuildRoot, 'payload.zip');
  await cp(portableRoot, payloadRoot, { recursive: true });
  await copyFile(join(root, 'packaging', 'uninstall.ps1'), join(payloadRoot, 'Uninstall.ps1'));
  await createFlatZip(payloadRoot, payloadZip);
  await verifyZip(payloadZip);

  const setupOutput = join(releaseRoot, installerName);
  await copyFile(setupBase, setupOutput);
  await appendFile(setupOutput, Buffer.from(installerPayloadMarker, 'ascii'));
  await appendFile(setupOutput, await readFile(payloadZip));
  const setupBytes = await readFile(setupOutput);
  const markerIndex = setupBytes.lastIndexOf(Buffer.from(installerPayloadMarker, 'ascii'));
  const payloadStart = markerIndex + installerPayloadMarker.length;
  if (markerIndex < 0 || setupBytes.subarray(payloadStart, payloadStart + 2).toString('ascii') !== 'PK') {
    throw new Error('The generated installer payload could not be verified.');
  }
  return setupOutput;
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

async function createFlatZip(directory, outputPath) {
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0) {
    run('zip', ['-9', '-q', '-r', outputPath, '.'], { cwd: directory });
    return;
  }
  const files = {};
  await collectZipFiles(directory, '', files);
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
  await addExecutableResources(launcher, ico, { persistPrebuilt: true });
  await stagePortable(launcher);
  const installer = await buildInstaller(ico);
  const { sourceStageRoot } = await stageSource();

  const portableZip = join(releaseRoot, portableZipName);
  const sourceZip = join(releaseRoot, sourceZipName);
  await createZip(releaseRoot, portableName, portableZip);
  await createZip(sourceStageRoot, sourceFolderName, sourceZip);
  await verifyZip(portableZip);
  await verifyZip(sourceZip);
  const installerStats = await stat(installer);
  const portableStats = await stat(portableZip);
  const sourceStats = await stat(sourceZip);
  const checksums = `${await sha256(installer)}  ${installerName}\n${await sha256(portableZip)}  ${portableZipName}\n${await sha256(sourceZip)}  ${sourceZipName}\n`;
  await writeFile(join(releaseRoot, 'SHA256SUMS.txt'), checksums);

  const files = await readdir(portableRoot, { withFileTypes: true });
  console.log(`Built ${installerName} (${(installerStats.size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`Built ${portableZipName} (${(portableStats.size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`Built ${sourceZipName} (${(sourceStats.size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`Portable root entries: ${files.map((item) => item.name).join(', ')}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
