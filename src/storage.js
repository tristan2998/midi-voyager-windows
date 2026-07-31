const PREFIX = 'midi-voyager-windows:';

function read(key, fallback) {
  try {
    const value = localStorage.getItem(PREFIX + key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (error) {
    console.warn('Could not persist setting', key, error);
  }
}

export class AppStore {
  constructor() {
    this.settings = read('settings', {
      view: 'waterfall',
      colorMode: 'track',
      zoom: 1,
      masterVolume: 0.82,
      metronome: false,
      countIn: 0,
      showPiano: true,
      showLabels: true,
      showGrid: true,
      theme: 'midnight',
      lastPerspective: 'performance',
      midiOutputOnly: true
    });
    this.recents = read('recents', []);
    this.playlists = read('playlists', [
      { id: 'favourites', name: 'Favourites', files: [] }
    ]);
    this.fileSettings = read('file-settings', {});
    this.customPerspectives = read('perspectives', []);
  }

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    write('settings', this.settings);
  }

  rememberFile(file) {
    const normalized = {
      name: file.name,
      path: file.path || null,
      size: file.size || 0,
      lastOpened: Date.now()
    };
    this.recents = [normalized, ...this.recents.filter((item) =>
      (normalized.path && item.path !== normalized.path) || (!normalized.path && item.name !== normalized.name)
    )].slice(0, 40);
    write('recents', this.recents);
  }

  removeRecent(index) {
    this.recents.splice(index, 1);
    write('recents', this.recents);
  }

  fileKey(file) {
    return encodeURIComponent(file.path || `${file.name}:${file.size || 0}`);
  }

  getFileSettings(file) {
    return this.fileSettings[this.fileKey(file)] || null;
  }

  saveFileSettings(file, settings) {
    this.fileSettings[this.fileKey(file)] = { ...settings, savedAt: Date.now() };
    const entries = Object.entries(this.fileSettings);
    if (entries.length > 500) {
      entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
      this.fileSettings = Object.fromEntries(entries.slice(0, 500));
    }
    write('file-settings', this.fileSettings);
  }

  createPlaylist(name) {
    const id = `playlist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const playlist = { id, name: name.trim() || 'New playlist', files: [] };
    this.playlists.push(playlist);
    write('playlists', this.playlists);
    return playlist;
  }

  renamePlaylist(id, name) {
    const playlist = this.playlists.find((item) => item.id === id);
    if (!playlist) return;
    playlist.name = name.trim() || playlist.name;
    write('playlists', this.playlists);
  }

  deletePlaylist(id) {
    if (id === 'favourites') return;
    this.playlists = this.playlists.filter((item) => item.id !== id);
    write('playlists', this.playlists);
  }

  addToPlaylist(id, file) {
    const playlist = this.playlists.find((item) => item.id === id);
    if (!playlist) return;
    const entry = { name: file.name, path: file.path || null, size: file.size || 0 };
    if (!playlist.files.some((item) => (entry.path && item.path === entry.path) || (!entry.path && item.name === entry.name))) {
      playlist.files.push(entry);
      write('playlists', this.playlists);
    }
  }

  removeFromPlaylist(id, index) {
    const playlist = this.playlists.find((item) => item.id === id);
    if (!playlist) return;
    playlist.files.splice(index, 1);
    write('playlists', this.playlists);
  }

  savePerspective(perspective) {
    const existing = this.customPerspectives.findIndex((item) => item.id === perspective.id);
    if (existing >= 0) this.customPerspectives[existing] = perspective;
    else this.customPerspectives.push(perspective);
    write('perspectives', this.customPerspectives);
  }

  deletePerspective(id) {
    this.customPerspectives = this.customPerspectives.filter((item) => item.id !== id);
    write('perspectives', this.customPerspectives);
  }

  exportSettings() {
    return JSON.stringify({
      version: 1,
      settings: this.settings,
      playlists: this.playlists,
      fileSettings: this.fileSettings,
      customPerspectives: this.customPerspectives
    }, null, 2);
  }

  importSettings(json) {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') throw new Error('This is not a MIDI Voyager settings file.');
    if (data.settings) this.settings = { ...this.settings, ...data.settings };
    if (Array.isArray(data.playlists)) this.playlists = data.playlists;
    if (data.fileSettings && typeof data.fileSettings === 'object') this.fileSettings = data.fileSettings;
    if (Array.isArray(data.customPerspectives)) this.customPerspectives = data.customPerspectives;
    write('settings', this.settings);
    write('playlists', this.playlists);
    write('file-settings', this.fileSettings);
    write('perspectives', this.customPerspectives);
  }
}
