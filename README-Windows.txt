MIDI VOYAGER WINDOWS 1.1.1 (64-bit)
================================================

Version 1.1.1 adds a Windows installer, shortcuts, clean uninstall, MIDI Open
with support and one consistent Windows-themed icon. Version 1.1.0 added the
SoundFont priority controls and matching falling-note/piano-key colours.

INSTALLER (recommended)
  1. Run "MIDI Voyager Windows Setup 1.1.1.exe".
  2. Press Install. Administrator permission is not required.
  3. Start the app from the Start Menu or desktop shortcut.

PORTABLE
  1. Extract the entire portable ZIP.
  2. Double-click "MIDI Voyager Windows.exe".

OPEN WITH
  Right-click a .mid, .midi, .kar, .rmi, .rmid or .xmf file, choose Open with,
  then select MIDI Voyager Windows. Windows can optionally remember the choice.

For portable use, keep the EXE and the app, runtime and ui folders together.
Exports are saved in Music\MIDI Voyager Exports. If the application
cannot open on Windows 10, install the current Microsoft Edge WebView2 Runtime.
If startup-error.txt names VCRUNTIME140.dll, install Microsoft's Visual C++
2015-2022 Redistributable (x64), then start the app again.

SUPPORTED WORKFLOWS
  - MIDI/KAR/RMID/XMF playback with bundled GeneralUser GS sounds
  - SF2, SF3 and DLS sound-bank loading, priority ordering and enable controls
  - Waterfall, piano roll, staff, karaoke and event views
  - Per-channel mixer, instruments, transpose, tempo and master volume
  - Chord/key analysis, lyrics, markers, loops, metronome and count-in
  - Playlists, favourites, recent files, perspectives and settings backup
  - USB MIDI input/output (device and Windows Web MIDI support permitting)
  - Modified MIDI, WAV and lyrics/chords export

SHORTCUTS
  Ctrl+O       Open MIDI              Space         Play/pause
  Ctrl+E       Export                 Left/Right    Seek
  Ctrl+D       Add to favourites      [ and ]       Transpose
  1 through 5  Change view            - and +       Tempo

NOTES
  - The installer and portable build target 64-bit Windows 10/11.
  - The EXE is not code-signed, so Windows may show its normal first-run warning.
  - SFZ and Android-only integrations are not part of this first Windows release.
  - See THIRD-PARTY-NOTICES.txt for included component licences.
