export const BUILTIN_SOUNDFONT_KEY = 'builtin:default';

export function normalizeBankOffset(value) {
  return Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
}

export function summarizeSoundBank(soundBank) {
  const info = soundBank?.soundBankInfo || {};
  const presets = Array.isArray(soundBank?.presets) ? soundBank.presets : [];
  const presetList = presets.map((preset, index) => ({
    id: `${preset.isDrum ? 'd' : 'm'}:${preset.bankMSB || 0}:${preset.bankLSB || 0}:${preset.program || 0}:${index}`,
    name: String(preset.name || `Preset ${(preset.program || 0) + 1}`),
    program: normalizeBankOffset(preset.program),
    bankMSB: Math.max(0, Math.min(128, Math.round(Number(preset.bankMSB) || 0))),
    bankLSB: Math.max(0, Math.min(16383, Math.round(Number(preset.bankLSB) || 0))),
    isDrum: Boolean(preset.isDrum || preset.isGMGSDrum)
  }));
  const version = info.version && Number.isFinite(Number(info.version.major))
    ? `${Number(info.version.major)}.${Number(info.version.minor) || 0}`
    : '';
  return {
    type: String(soundBank?.type || 'sf2').toUpperCase(),
    internalName: String(info.name || ''),
    author: String(info.engineer || ''),
    product: String(info.product || ''),
    comment: String(info.comment || ''),
    version,
    presetCount: presets.length,
    melodicPresetCount: presetList.filter((preset) => !preset.isDrum).length,
    drumPresetCount: presetList.filter((preset) => preset.isDrum).length,
    instrumentCount: Array.isArray(soundBank?.instruments) ? soundBank.instruments.length : 0,
    sampleCount: Array.isArray(soundBank?.samples) ? soundBank.samples.length : 0,
    presets: presetList
  };
}

export function soundFontStorageKey(bank) {
  if (bank?.builtIn || bank?.id === 'default') return BUILTIN_SOUNDFONT_KEY;
  if (bank?.sourcePath) return `file:${bank.sourcePath}`;
  return `session:${bank?.id || ''}`;
}

export function moveSoundBank(order, sourceId, targetId, placeAfter = false) {
  const current = [...new Set((order || []).filter(Boolean))];
  if (sourceId === targetId || !current.includes(sourceId) || !current.includes(targetId)) return current;
  const next = current.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId);
  return next;
}

export function resolveSavedSoundBankOrder(banks, savedOrder, legacyFonts = []) {
  const byStorageKey = new Map((banks || []).map((bank) => [soundFontStorageKey(bank), bank.id]));
  const requestedKeys = Array.isArray(savedOrder) && savedOrder.length
    ? savedOrder
    : [
        ...[...(legacyFonts || [])].reverse().map((font) => `file:${font.path}`),
        BUILTIN_SOUNDFONT_KEY
      ];
  const resolved = [];
  for (const key of requestedKeys) {
    const id = byStorageKey.get(key);
    if (id && !resolved.includes(id)) resolved.push(id);
  }
  for (const bank of banks || []) if (!resolved.includes(bank.id)) resolved.push(bank.id);
  return resolved;
}
