# MIDI Voyager Windows

MIDI Voyager Windows is a clean-room, 64-bit Windows MIDI workstation built from the feature behaviour of the supplied Android app. It uses the Windows WebView2 surface instead of bundling a full browser, performs synthesis in an audio worklet, and draws dense songs on an adaptive Canvas renderer.

Version 1.1.1 adds a normal per-user Windows installer, Start Menu and optional desktop shortcuts, clean uninstall support, and Windows “Open with” integration for MIDI files. It also replaces the former icon variants with one Windows-themed MIDI Voyager icon throughout the EXE, taskbar and interface. Version 1.1.0 added the persistent SoundFont stack and matched piano-key colours.

## Install on Windows

1. Run `MIDI Voyager Windows Setup 1.1.1.exe`.
2. Press **Install**. Administrator permission is not required.
3. Launch it from the Start Menu or desktop shortcut.

The installer adds MIDI Voyager to Apps & Features and to Windows’ **Open with** menu for `.mid`, `.midi`, `.kar`, `.rmi`, `.rmid` and `.xmf` files without forcing it to become your default app. Right-click a MIDI file, choose **Open with**, then select MIDI Voyager Windows. A second file-open request is handed to the existing app window instead of starting a duplicate instance.

## Portable alternative

1. Extract the complete `MIDI Voyager Windows 1.1.1 x64.zip` archive.
2. Keep the `app`, `runtime`, and `ui` folders beside `MIDI Voyager Windows.exe`.
3. Double-click `MIDI Voyager Windows.exe`.

Windows 11 includes Microsoft Edge WebView2. On Windows 10, install the current WebView2 Runtime if Windows does not offer it automatically. The desktop host also uses the common Microsoft Visual C++ 2015–2022 Redistributable (x64); install it from Microsoft if the first-run message names `VCRUNTIME140.dll`. The portable package requires no installation. Both editions write exported songs to `Music\MIDI Voyager Exports`.

## Feature set

- MIDI 0/1/2, KAR, RMID and XMF playback through a bundled GeneralUser GS bank
- SF2, SF3 and DLS sound-bank stacking with persistent drag-and-drop priority and per-bank enable controls
- Waterfall, piano-roll, staff, karaoke and event views
- Track/channel mixer with mute, solo, volume, pan, transpose and locked instruments
- Tempo, pitch, seek, count-in, metronome, loop regions and named markers
- Automatic chord and key analysis, lyric timing, signatures and tempo maps
- Recent files, favourites, playlists, per-file state, perspectives and settings backup
- Windows installer, clean uninstall, shortcuts and Open-with file registration
- USB MIDI input and external MIDI output where Web MIDI is available
- Modified MIDI, offline WAV, and lyric/chord cue-sheet export
- Dense/Black MIDI safeguards, capped draw windows and off-interface-thread synthesis

SFZ import and Android-only integrations are not included in this first Windows release. Convert SFZ banks to SF2/SF3 or DLS before loading them.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` / `Ctrl+Shift+O` | Open one / several MIDI files |
| `Ctrl+E` | Export |
| `Ctrl+D` | Add the current file to Favourites |
| `Space` | Play or pause |
| `Left` / `Right` | Seek 2 seconds |
| `Shift+Left` / `Shift+Right` | Seek 10 seconds |
| `Home` | Stop |
| `[` / `]` | Transpose down / up |
| `-` / `+` | Tempo down / up |
| `1`–`5` | Switch visualisation |
| `Ctrl+mouse wheel` | Zoom |

## Build from source

Install Node.js 24 or later, run `npm install`, then `npm test` and `npm run build`. The package includes a prebuilt open-source launcher for Windows builds; GNU binutils can rebuild that launcher from `packaging/launcher.S` and the `.def` files.

This port does not copy executable code, branding assets, or bundled audio assets from the supplied APK. Third-party components and their licences are listed in `THIRD-PARTY-NOTICES.txt` in the portable package.
