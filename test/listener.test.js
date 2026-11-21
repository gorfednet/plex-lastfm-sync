import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLastfm } from '../src/lastfm.js';
import { createPlex } from '../src/plex.js';
import { createListener } from '../src/listener.js';
import { boundaryOf, payloadFromMultipart } from '../src/multipart.js';
import { createMemoryStore } from '../src/state.js';
import { fakeLastfm, fakePlex, track, TEST } from './fakes.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/media.rate.json', import.meta.url), 'utf8'));

function multipart(payload, { thumb = true } = {}) {
  const b = '----plexboundary1234';
  const parts = [`--${b}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`];
  if (thumb) parts.push(`--${b}\r\nContent-Disposition: form-data; name="thumb"; filename="poster.jpg"\r\nContent-Type: image/jpeg\r\n\r\nÿØÿà not a real image\r\n`);
  parts.push(`--${b}--\r\n`);
  return { body: Buffer.from(parts.join(''), 'latin1'), type: `multipart/form-data; boundary=${b}` };
}

async function setup({ plexTracks, loved = [], accountId } = {}) {
  const lf = await fakeLastfm({ loved });
  const px = await fakePlex({ tracks: plexTracks ?? [track('101', 'The Band', 'Song One', { rating: 10 })] });
  const config = { plex: { serverUuid: TEST.serverUuid, accountId }, listener: { host: '127.0.0.1', port: 0, pathToken: TEST.pathToken } };
  const lastfm = createLastfm({ apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, username: TEST.username, baseUrl: lf.url, sleep: async () => {}, perSecond: 1000 });
  const plex = createPlex({ url: px.url, token: TEST.plexToken });
  const store = createMemoryStore();
  const logs = [];
  const log = { info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]), error: (m, f) => logs.push(['error', m, f]) };
  const l = createListener({ config, plex, lastfm, store, log });
  await new Promise((r) => l.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${l.server.address().port}`;
  const post = (path, { body, type } = {}) => fetch(base + path, { method: 'POST', headers: type ? { 'content-type': type } : {}, body });
  const hook = `/hook/${TEST.pathToken}`;
  return { lf, px, l, store, logs, post, hook, base, close: async () => { await new Promise((r) => l.server.close(r)); await lf.close(); await px.close(); } };
}

test('multipart: the payload part is read and the thumbnail part skipped', () => {
  const m = multipart(fixture);
  assert.deepEqual(JSON.parse(payloadFromMultipart(m.body, boundaryOf(m.type))), fixture);
  assert.equal(payloadFromMultipart(Buffer.from('nonsense'), 'x'), null);
});

test('a 5-star rating loves the track on Last.fm', async () => {
  const t = await setup();
  try {
    const m = multipart(fixture);
    const res = await t.post(t.hook, m);
    assert.equal(res.status, 200);
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, [{ artist: 'The Band', title: 'Song One' }]);
    assert.ok(t.store.get('101'));
  } finally { await t.close(); }
});

test('the rating is read back from Plex, so a stale or forged 10 in the body does nothing', async () => {
  const t = await setup({ plexTracks: [track('101', 'The Band', 'Song One', { rating: 6 })] });
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, []);
    assert.equal(t.lf.calls.filter((c) => c.method === 'track.love').length, 0);
  } finally { await t.close(); }
});

test('lowering a track this tool loved unloves it; an unknown track is left alone', async () => {
  const t = await setup({ loved: [{ artist: 'Other', title: 'Hand Loved' }] });
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    t.px.store.get('101').userRating = 4;
    await t.post(t.hook, multipart({ ...fixture, rating: 4 }));
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, [{ artist: 'Other', title: 'Hand Loved' }]);
    // a track never seen at 5 stars and rated lower: no Last.fm call at all
    t.px.store.set('202', { type: 'track', ratingKey: '202', title: 'X', grandparentTitle: 'Y', userRating: 2 });
    const before = t.lf.calls.length;
    await t.post(t.hook, multipart({ ...fixture, Metadata: { ...fixture.Metadata, ratingKey: '202' } }));
    await t.l.idle();
    assert.equal(t.lf.calls.length, before);
  } finally { await t.close(); }
});

test('removing the rating (unrated) also unloves a track this tool loved', async () => {
  const t = await setup();
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    delete t.px.store.get('101').userRating;
    await t.post(t.hook, multipart({ ...fixture, rating: 0 }));
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, []);
  } finally { await t.close(); }
});

test('a compilation track is loved under its track artist, not "Various Artists"', async () => {
  const t = await setup({ plexTracks: [track('101', 'Real Artist', 'Song One', { rating: 10, albumArtist: 'Various Artists' })] });
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, [{ artist: 'Real Artist', title: 'Song One' }]);
  } finally { await t.close(); }
});

test('wrong path, wrong token, wrong method and unknown paths all answer 404 and do nothing', async () => {
  const t = await setup();
  try {
    const m = multipart(fixture);
    for (const path of ['/', '/hook/', '/hook/wrong', `${t.hook}x`, `/hook/${TEST.pathToken.slice(0, -1)}`, '/other']) {
      assert.equal((await t.post(path, m)).status, 404, path);
    }
    assert.equal((await fetch(t.base + t.hook)).status, 404);
    await t.l.idle();
    assert.equal(t.lf.calls.length, 0);
  } finally { await t.close(); }
});

test('a payload from another Plex server is rejected', async () => {
  const t = await setup();
  try {
    const res = await t.post(t.hook, multipart({ ...fixture, Server: { uuid: 'someone-elses-server' } }));
    assert.equal(res.status, 403);
    await t.l.idle();
    assert.equal(t.lf.calls.length, 0);
  } finally { await t.close(); }
});

test('other events, non-tracks and other accounts are ignored; garbage is a 400', async () => {
  const t = await setup({ accountId: '1' });
  try {
    assert.equal((await t.post(t.hook, multipart({ ...fixture, event: 'media.play' }))).status, 200);
    assert.equal((await t.post(t.hook, multipart({ ...fixture, Metadata: { ...fixture.Metadata, type: 'album' } }))).status, 200);
    assert.equal((await t.post(t.hook, multipart({ ...fixture, Account: { id: 99 } }))).status, 200);
    assert.equal((await t.post(t.hook, { body: 'not json', type: 'application/json' })).status, 400);
    assert.equal((await t.post(t.hook, { body: 'x', type: 'text/plain' })).status, 400);
    assert.equal((await t.post(t.hook, { body: '--b--', type: 'multipart/form-data; boundary=b' })).status, 400);
    await t.l.idle();
    assert.equal(t.lf.calls.length, 0);
  } finally { await t.close(); }
});

test('an oversized body is refused', async () => {
  const t = await setup();
  try {
    let status;
    try { status = (await t.post(t.hook, { body: Buffer.alloc(6 * 1024 * 1024), type: 'application/json' })).status; } catch { status = 'reset'; }
    assert.ok(status === 413 || status === 'reset', String(status));
  } finally { await t.close(); }
});

test('logs never contain a credential, even when Last.fm fails', async () => {
  const t = await setup();
  try {
    t.lf.state.failWith.push(9, 9, 9, 9, 9); // Invalid session key, not retried
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    const text = JSON.stringify(t.logs);
    for (const v of [TEST.apiKey, TEST.sharedSecret, TEST.sessionKey, TEST.plexToken, TEST.pathToken]) assert.ok(!text.includes(v), 'secret in log');
    assert.ok(t.logs.some((l) => l[0] === 'error'));
  } finally { await t.close(); }
});

test('a track already loved by hand is never remembered, so lowering it leaves the love alone', async () => {
  const t = await setup({ loved: [{ artist: 'The Band', title: 'Song One' }] });
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    assert.equal(t.store.get('101'), undefined);
    assert.equal(t.lf.calls.filter((c) => c.method === 'track.love').length, 0);
    t.px.store.get('101').userRating = 2;
    await t.post(t.hook, multipart({ ...fixture, rating: 2 }));
    await t.l.idle();
    assert.equal(t.lf.calls.filter((c) => c.method === 'track.unlove').length, 0);
    assert.equal(t.lf.state.loved.length, 1);
  } finally { await t.close(); }
});

test('lowering one copy keeps the love while another copy of the song is still remembered at 5 stars', async () => {
  const t = await setup({ plexTracks: [track('101', 'The Band', 'Song One', { rating: 10, album: 'A' }), track('102', 'The Band', 'Song One', { rating: 10, album: 'B' })] });
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    t.store.set('102', { artist: 'The Band', title: 'Song One' });
    t.px.store.get('101').userRating = 2;
    await t.post(t.hook, multipart({ ...fixture, rating: 2 }));
    await t.l.idle();
    assert.equal(t.lf.state.loved.length, 1);
    assert.equal(t.store.get('101'), undefined);
  } finally { await t.close(); }
});

test('a rating key that is not digits is ignored and never reaches Plex', async () => {
  const t = await setup();
  try {
    for (const key of ['..', '1/../2', '1?x=1', '']) {
      assert.equal((await t.post(t.hook, multipart({ ...fixture, Metadata: { ...fixture.Metadata, ratingKey: key } }))).status, 200);
    }
    await t.l.idle();
    assert.ok(!t.px.seenUrls.some((u) => u.startsWith('/library/metadata')));
  } finally { await t.close(); }
});

test('a part header made to stall the parser is refused at once', () => {
  const b = 'bb';
  const evil = Buffer.from(`--${b}\r\n` + 'content-disposition:'.repeat(20000) + '\r\n\r\nx\r\n--' + b + '--\r\n', 'latin1');
  const t0 = Date.now();
  assert.equal(payloadFromMultipart(evil, b), null);
  assert.ok(Date.now() - t0 < 200, 'parser must not spend time on an oversized header');
});

test('payload fields of the wrong type are refused without crashing the listener', async () => {
  const t = await setup({ accountId: '1' });
  try {
    const bad = [
      { ...fixture, Metadata: { ...fixture.Metadata, ratingKey: { toString: 1 } } },
      { ...fixture, Metadata: { ...fixture.Metadata, ratingKey: ['101'] } },
      { ...fixture, Account: { id: { toString: 1 } } },
      { ...fixture, Server: { uuid: { toString: 1 } } },
      { ...fixture, Server: 'x' },
      { ...fixture, Metadata: null },
    ];
    for (const p of bad) assert.ok([200, 400, 403].includes((await t.post(t.hook, multipart(p))).status));
    // still alive, and still doing its job
    assert.equal((await t.post(t.hook, multipart(fixture))).status, 200);
    await t.l.idle();
    assert.equal(t.lf.state.loved.length, 1);
  } finally { await t.close(); }
});

test('two copies of one song: lowering one keeps the love, lowering the last removes it (no hand-seeding)', async () => {
  const t = await setup({ plexTracks: [track('101', 'The Band', 'Song One', { rating: 10, album: 'A' }), track('102', 'The Band', 'Song One', { rating: 10, album: 'B' })] });
  try {
    const rate = async (key, rating) => {
      if (rating) t.px.store.get(key).userRating = rating; else delete t.px.store.get(key).userRating;
      await t.post(t.hook, multipart({ ...fixture, Metadata: { ...fixture.Metadata, ratingKey: key } }));
      await t.l.idle();
    };
    await rate('101', 10);
    await rate('102', 10);
    assert.ok(t.store.get('101') && t.store.get('102'));
    await rate('101', 4);
    assert.equal(t.lf.state.loved.length, 1, 'other copy is still 5 stars');
    await rate('102', 0);
    assert.equal(t.lf.state.loved.length, 0);
  } finally { await t.close(); }
});

test('a reused rating key for a different track forgets the old entry and unloves nothing', async () => {
  const t = await setup({ plexTracks: [track('101', 'Someone Else', 'Different Song', { rating: 3 })], loved: [{ artist: 'The Band', title: 'Song One' }] });
  try {
    t.store.set('101', { artist: 'The Band', title: 'Song One' }); // remembered from before a library rebuild
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    assert.equal(t.store.get('101'), undefined);
    assert.deepEqual(t.lf.state.loved, [{ artist: 'The Band', title: 'Song One' }]);
  } finally { await t.close(); }
});

test('a track Last.fm has no page for is still loved and remembered', async () => {
  const t = await setup();
  try {
    t.lf.state.unknown = new Set(['Song One']);
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, [{ artist: 'The Band', title: 'Song One' }]);
    assert.ok(t.store.get('101'));
  } finally { await t.close(); }
});

test('a new 5-star copy of a song the tool already loved is remembered without asking Last.fm', async () => {
  const t = await setup({ plexTracks: [track('101', 'The Band', 'Song One', { rating: 10, album: 'A' }), track('102', 'The Band', 'Song One', { rating: 10, album: 'B' })] });
  try {
    await t.post(t.hook, multipart(fixture));
    await t.l.idle();
    t.lf.state.unknown = new Set(['Song One']); // getInfo would now fail for this track
    await t.post(t.hook, multipart({ ...fixture, Metadata: { ...fixture.Metadata, ratingKey: '102' } }));
    await t.l.idle();
    assert.ok(t.store.get('102'));
  } finally { await t.close(); }
});

test('a rating key longer than 12 digits is accepted and handled, not silently ignored', async () => {
  const t = await setup({ plexTracks: [track('12345678901234', 'The Band', 'Song One', { rating: 10 })] });
  try {
    const m = multipart({ ...fixture, Metadata: { ...fixture.Metadata, ratingKey: '12345678901234' } });
    assert.equal((await t.post(t.hook, m)).status, 200);
    await t.l.idle();
    assert.deepEqual(t.lf.state.loved, [{ artist: 'The Band', title: 'Song One' }]);
  } finally { await t.close(); }
});

test('tracks whose names fold to nothing are never treated as the same song', async () => {
  const t = await setup({ plexTracks: [track('101', '!!!', '???', { rating: 10 }), track('102', '!!!', '!!!', { rating: 10 })] });
  try {
    t.store.set('101', { artist: '!!!', title: '???' });
    await t.post(t.hook, multipart({ ...fixture, Metadata: { ...fixture.Metadata, ratingKey: '102' } }));
    await t.l.idle();
    assert.equal(t.store.get('102') === undefined || t.lf.calls.some((c) => c.method === 'track.getInfo'), true);
  } finally { await t.close(); }
});
