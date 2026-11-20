import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { trackKey } from './match.js';

// The tool's memory of Last.fm loves it made itself, keyed by Plex rating key.
// Only these are ever unloved, and only when Plex drops them below 5 stars. A love made by hand stays.
//
// Every operation re-reads the file, changes it and writes it back in one synchronous step, so a bulk run
// and the listener rarely overwrite each other. Two writes in the very same instant can still lose one entry.
// That forgets a love the tool made, which fails safe: the love is never unloved.
export function createFileStore(path) {
  function read() {
    try {
      const s = JSON.parse(readFileSync(path, 'utf8'));
      if (s && typeof s.fiveStar === 'object' && s.fiveStar && !Array.isArray(s.fiveStar)
        && Object.values(s.fiveStar).every((v) => v && typeof v.artist === 'string' && typeof v.title === 'string')) return s.fiveStar;
      throw new Error('bad shape');
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      // A damaged file is never read as "empty": the next save would erase the memory.
      throw new Error(`State file ${path} is unreadable. Fix or remove it, then start again.`);
    }
  }
  function write(entries) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      closeSync(openSync(tmp, 'w', 0o600));
      writeFileSync(tmp, JSON.stringify({ fiveStar: entries }, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to remove */ }
      throw e;
    }
  }
  return {
    check: () => { read(); },
    get: (key) => read()[key],
    entries: () => Object.entries(read()),
    set(key, value) { const s = read(); s[key] = value; write(s); },
    del(key) { const s = read(); delete s[key]; write(s); },
    setMany(obj) { const s = read(); Object.assign(s, obj); write(s); },
  };
}

export function createMemoryStore() {
  const s = {};
  return {
    check() {},
    get: (key) => s[key],
    entries: () => Object.entries(s),
    set(key, value) { s[key] = value; },
    del(key) { delete s[key]; },
    setMany(obj) { Object.assign(s, obj); },
  };
}

// Does another remembered track fold to the same artist and title as this one?
export function otherCopy(store, key, { artist, title }) {
  const want = trackKey(artist, title);
  if (want === null) return false;
  return store.entries().some(([k, v]) => k !== key && trackKey(v.artist, v.title) === want);
}
