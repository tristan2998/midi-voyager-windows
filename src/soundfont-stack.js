export const BUILTIN_SOUNDFONT_KEY = 'builtin:default';

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
