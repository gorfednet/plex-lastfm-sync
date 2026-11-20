import { createHash } from 'node:crypto';
import { createLimiter } from './ratelimit.js';

const DEFAULT_BASE = 'https://ws.audioscrobbler.com/2.0/';
// Every request has a deadline and refuses redirects.
const GUARD = () => ({ signal: AbortSignal.timeout(15_000), redirect: 'error' });
const RETRYABLE = new Set([8, 11, 16, 29]); // operation failed, offline, temporary error, rate limit

export class LastfmError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Signature: md5 of the sorted name+value pairs, then the shared secret. `format` and `callback` are left out.
export function sign(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  const base = keys.map((k) => k + params[k]).join('') + secret;
  return createHash('md5').update(base, 'utf8').digest('hex');
}

export function createLastfm({ apiKey, sharedSecret, sessionKey, username, baseUrl = DEFAULT_BASE, fetchImpl = fetch, perSecond = 5, retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limiter }) {
  const wait = limiter ?? createLimiter(perSecond);

  async function call(method, params = {}, { signed = false, post = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      await wait();
      const all = { method, api_key: apiKey, ...params };
      if (signed) {
        if (sessionKey && method !== 'auth.getSession' && method !== 'auth.getToken') all.sk = sessionKey;
        all.api_sig = sign(all, sharedSecret);
      }
      all.format = 'json';
      const body = new URLSearchParams(all);
      let res;
      try {
        res = post
          ? await fetchImpl(baseUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, ...GUARD() })
          : await fetchImpl(`${baseUrl}?${body}`, GUARD());
      } catch (e) {
        if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new LastfmError(0, `Last.fm unreachable (${method})`);
      }
      let data = null;
      try { data = await res.json(); } catch { /* handled below */ }
      if (data && data.error) {
        if (RETRYABLE.has(data.error) && attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new LastfmError(data.error, `Last.fm ${method} error ${data.error}: ${data.message}`);
      }
      if (!res.ok || !data) {
        if (res.status >= 500 && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new LastfmError(res.status, `Last.fm ${method} HTTP ${res.status}`);
      }
      return data;
    }
  }

  return {
    getToken: async () => (await call('auth.getToken', {}, { signed: true })).token,
    authUrl: (token) => `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`,
    getSession: async (token) => (await call('auth.getSession', { token }, { signed: true })).session,
    love: (artist, track) => call('track.love', { artist, track }, { signed: true, post: true }),
    unlove: (artist, track) => call('track.unlove', { artist, track }, { signed: true, post: true }),
    // Is this track on the user's loved list? Anything but a clear yes or no is an error, so a
    // wrong username or a changed reply can never read as "not loved".
    async isLoved(artist, track) {
      const data = await call('track.getInfo', { artist, track, username, autocorrect: '0' });
      const v = data.track?.userloved;
      if (v === '1') return true;
      if (v === '0') return false;
      throw new LastfmError(0, 'Last.fm did not say whether the track is loved');
    },
    // The account the session key belongs to. Checked at start-up against the configured username.
    sessionUser: async () => (await call('user.getInfo', {}, { signed: true })).user?.name,
    // Every loved track for the user, in pages of 200. Fails if the count it collected differs from Last.fm's own total.
    async getLovedTracks(user) {
      const out = [];
      let total = NaN;
      for (let page = 1; ; page++) {
        const data = await call('user.getLovedTracks', { user, limit: '200', page: String(page) });
        const lt = data.lovedtracks;
        if (!lt) throw new LastfmError(0, 'Last.fm returned no loved-tracks list');
        const tracks = lt?.track ? (Array.isArray(lt.track) ? lt.track : [lt.track]) : [];
        for (const t of tracks) out.push({ artist: t.artist?.name ?? '', title: t.name ?? '' });
        const totalPages = Number(lt?.['@attr']?.totalPages ?? 1);
        const rawTotal = lt?.['@attr']?.total;
        total = /^\d+$/.test(String(rawTotal ?? '')) ? Number(rawTotal) : NaN;
        if (page >= totalPages || tracks.length === 0) break;
      }
      if (!Number.isFinite(total)) throw new LastfmError(0, 'Last.fm did not report how many loved tracks there are');
      if (out.length !== total) throw new LastfmError(0, `Last.fm loved list incomplete: read ${out.length} of ${total}. Run again.`);
      return out;
    },
  };
}
