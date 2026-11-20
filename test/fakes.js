// A fake Last.fm API and a fake Plex server, both real HTTP servers on loopback.
// Every credential here is a made-up test value.
import { createServer } from 'node:http';
import { sign } from '../src/lastfm.js';

export const TEST = {
  apiKey: 'test-api-key-0001',
  sharedSecret: 'test-shared-secret-0002',
  sessionKey: 'test-session-key-0003',
  plexToken: 'test-plex-token-0004',
  pathToken: 'test-path-token-0123456789-abcdefghijklmnop',
  serverUuid: 'test-server-uuid-0005',
  username: 'testuser',
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

export async function fakeLastfm({ loved = [], failWith = [] } = {}) {
  const calls = [];
  const state = { loved: [...loved], failWith: [...failWith], failTitles: new Set() };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://x');
    const params = Object.fromEntries(req.method === 'POST' ? new URLSearchParams(Buffer.concat(chunks).toString()) : url.searchParams);
    const send = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    const method = params.method;
    calls.push({ method, httpMethod: req.method, params });
    if (state.failWith.length) { const code = state.failWith.shift(); return send({ error: code, message: 'injected' }); }
    if (method === 'track.love' && state.failTitles.has(params.track)) return send({ error: 6, message: 'Track not found' });
    if (params.api_key !== TEST.apiKey) return send({ error: 10, message: 'Invalid API key' });
    const signedMethods = ['auth.getToken', 'auth.getSession', 'track.love', 'track.unlove', 'user.getInfo'];
    if (signedMethods.includes(method)) {
      const { api_sig, ...rest } = params;
      if (api_sig !== sign(rest, TEST.sharedSecret)) return send({ error: 13, message: 'Invalid method signature' });
    }
    if (method === 'track.love' || method === 'track.unlove') {
      if (params.sk !== TEST.sessionKey) return send({ error: 9, message: 'Invalid session key' });
      const i = state.loved.findIndex((t) => t.artist === params.artist && t.title === params.track);
      if (method === 'track.love' && i === -1) state.loved.push({ artist: params.artist, title: params.track });
      if (method === 'track.unlove' && i !== -1) state.loved.splice(i, 1);
      return send({});
    }
    if (method === 'user.getInfo') return send({ user: { name: state.sessionUser ?? TEST.username } });
    if (method === 'track.getInfo') {
      if (params.username !== TEST.username) return send({ error: 6, message: 'username required' });
      if (state.unknown?.has(params.track)) return send({ error: 6, message: 'Track not found' });
      return send({ track: { name: params.track, userloved: state.loved.some((t) => t.artist === params.artist && t.title === params.track) ? '1' : '0' } });
    }
    if (method === 'auth.getToken') return send({ token: 'test-auth-token' });
    if (method === 'auth.getSession') return send({ session: { name: TEST.username, key: TEST.sessionKey } });
    if (method === 'user.getLovedTracks') {
      const limit = Number(params.limit), page = Number(params.page);
      const slice = state.loved.slice((page - 1) * limit, page * limit);
      return send({ lovedtracks: { track: slice.map((t) => ({ name: t.title, artist: { name: t.artist } })), '@attr': { page: String(page), total: String(state.totalOverride ?? state.loved.length), totalPages: String(Math.max(1, Math.ceil(state.loved.length / limit))) } } });
    }
    send({ error: 3, message: 'Invalid method' });
  });
  const url = await listen(server);
  return { url: url + '/2.0/', calls, state, close: () => new Promise((r) => server.close(r)) };
}

export async function fakePlex({ tracks = [], pageSize = 200, omitTotal = false, totalOverride } = {}) {
  const store = new Map(tracks.map((t) => [String(t.ratingKey), { type: 'track', ...t }]));
  const rated = [];
  const seenUrls = [];
  const server = createServer((req, res) => {
    seenUrls.push(req.url);
    const send = (code, container) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ MediaContainer: container })); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/identity') return send(200, { machineIdentifier: TEST.serverUuid });
    if (req.headers['x-plex-token'] !== TEST.plexToken) return send(401, {});
    if (url.pathname === '/library/sections') return send(200, { Directory: [{ key: '1', type: 'artist', title: 'Music' }, { key: '2', type: 'movie', title: 'Films' }] });
    if (url.pathname === '/library/sections/1/all') {
      const start = Number(url.searchParams.get('X-Plex-Container-Start'));
      const all = [...store.values()];
      return send(200, { ...(omitTotal ? {} : { totalSize: totalOverride ?? all.length }), Metadata: all.slice(start, start + pageSize) });
    }
    const meta = /^\/library\/metadata\/(\d+)$/.exec(url.pathname);
    if (meta) { const t = store.get(meta[1]); return send(t ? 200 : 404, t ? { Metadata: [t] } : {}); }
    if (url.pathname === '/:/rate' && req.method === 'PUT') {
      const t = store.get(url.searchParams.get('key'));
      if (!t) return send(404, {});
      t.userRating = Number(url.searchParams.get('rating'));
      rated.push({ key: url.searchParams.get('key'), rating: t.userRating });
      return send(200, {});
    }
    send(404, {});
  });
  const url = await listen(server);
  return { url, store, rated, seenUrls, close: () => new Promise((r) => server.close(r)) };
}

export function track(ratingKey, artist, title, { album = 'Album', rating, albumArtist } = {}) {
  const t = { ratingKey, title, grandparentTitle: albumArtist ?? artist, parentTitle: album };
  if (albumArtist) t.originalTitle = artist;
  if (rating !== undefined) t.userRating = rating;
  return t;
}
