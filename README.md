# MIDI Voyager Windows

MIDI Voyager Windows is a clean-room, 64-bit Windows MIDI workstation built from the feature behaviour of the supplied Android app. It uses the Windows WebView2 surface instead of bundling a full browser, performs synthesis in an audio worklet, and draws dense songs on an adaptive Canvas renderer.

Version 1.0.2 corrects the waterfall piano to use real white/black-key geometry, accurate 88-key range calculation, aligned falling notes and matching mouse hit-testing. Version 1.0.1 fixed Windows file-dialog imports for MIDI and SoundFont files by using validated, chunked native reads with a same-origin compatibility path.

## Run the portable application

1. Extract the complete `MIDI Voyager Windows 1.0.2 x64.zip` archive.
2. Keep the `app`, `runtime`, and `ui` folders beside `MIDI Voyager Windows.exe`.
3. Double-click `MIDI Voyager Windows.exe`.

Windows 11 includes Microsoft Edge WebView2. On Windows 10, install the current WebView2 Runtime if Windows does not offer it automatically. The desktop host also uses the common Microsoft Visual C++ 2015–2022 Redistributable (x64); install it from Microsoft if the first-run message names `VCRUNTIME140.dll`. The application is portable and writes exported songs to `Music\MIDI Voyager Exports`.

## Feature set

- MIDI 0/1/2, KAR, RMID and XMF playback through a bundled GeneralUser GS bank
- SF2, SF3 and DLS sound-bank stacking with per-bank priority
- Waterfall, piano-roll, staff, karaoke and event views
- Track/channel mixer with mute, solo, volume, pan, transpose and locked instruments
- Tempo, pitch, seek, count-in, metronome, loop regions and named markers
- Automatic chord and key analysis, lyric timing, signatures and tempo maps
- Recent files, favourites, playlists, per-file state, perspectives and settings backup
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
