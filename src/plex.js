// A small Plex client. The token travels in a header, never in a URL, so it cannot land in an access log.
const PAGE = 200;
// Every request has a deadline and refuses redirects (a redirect would carry the token elsewhere).
const GUARD = () => ({ signal: AbortSignal.timeout(15_000), redirect: 'error' });

export class PlexError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Unrated is absent. Anything present must be a number: a value we can't read is an error, never "unrated".
function ratingOf(v) {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) throw new PlexError(0, 'Plex returned a rating that is not a number');
  return n;
}

export function toTrack(m) {
  return {
    ratingKey: String(m.ratingKey),
    title: m.title ?? '',
    // `originalTitle` is the track artist when it differs from the album artist (compilations).
    artist: m.originalTitle || m.grandparentTitle || '',
    albumArtist: m.grandparentTitle || '',
    album: m.parentTitle || '',
    rating: ratingOf(m.userRating),
  };
}

export function createPlex({ url, token, fetchImpl = fetch, pageDelayMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const headers = {
    accept: 'application/json',
    'x-plex-token': token,
    'x-plex-product': 'plex-lastfm-sync',
    'x-plex-client-identifier': 'plex-lastfm-sync',
  };

  async function get(path) {
    let res;
    try { res = await fetchImpl(url + path, { headers, ...GUARD() }); } catch { throw new PlexError(0, 'Plex unreachable'); }
    if (!res.ok) throw new PlexError(res.status, `Plex GET ${path.split('?')[0]} HTTP ${res.status}`);
    return (await res.json()).MediaContainer ?? {};
  }

  return {
    // Needs no token; used by init to learn the server's UUID.
    async identity() {
      const res = await fetchImpl(url + '/identity', { headers: { accept: 'application/json' }, ...GUARD() });
      if (!res.ok) throw new PlexError(res.status, `Plex /identity HTTP ${res.status}`);
      return (await res.json()).MediaContainer?.machineIdentifier;
    },
    async musicSections() {
      const c = await get('/library/sections');
      return (c.Directory ?? []).filter((d) => d.type === 'artist').map((d) => ({ key: String(d.key), title: d.title }));
    },
    async track(ratingKey) {
      const c = await get(`/library/metadata/${encodeURIComponent(ratingKey)}`);
      const m = c.Metadata?.[0];
      if (!m || m.type !== 'track') return null;
      return toTrack(m);
    },
    // Reads every track, one page at a time, pausing between pages so Plex is never loaded hard.
    async allTracks(sectionKey) {
      const out = [];
      let total = 0;
      for (let start = 0; ; start += PAGE) {
        const c = await get(`/library/sections/${encodeURIComponent(sectionKey)}/all?type=10&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`);
        const items = c.Metadata ?? [];
        if (!Number.isInteger(c.totalSize)) throw new PlexError(0, 'Plex did not report a library size');
        total = c.totalSize;
        for (const m of items) out.push(toTrack(m));
        if (start + items.length >= total || items.length === 0) break;
        if (pageDelayMs) await sleep(pageDelayMs);
      }
      if (out.length !== total) throw new PlexError(0, `Plex library read incomplete: ${out.length} of ${total} tracks`);
      return out;
    },
    async rate(ratingKey, rating) {
      const q = new URLSearchParams({ key: ratingKey, identifier: 'com.plexapp.plugins.library', rating: String(rating) });
      let res;
      try { res = await fetchImpl(`${url}/:/rate?${q}`, { method: 'PUT', headers, ...GUARD() }); } catch { throw new PlexError(0, 'Plex unreachable'); }
      if (!res.ok) throw new PlexError(res.status, `Plex rate HTTP ${res.status}`);
    },
  };
}
