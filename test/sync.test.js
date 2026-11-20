import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLastfm } from '../src/lastfm.js';
import { createPlex } from '../src/plex.js';
import { runBulk } from '../src/bulk.js';
import { createMemoryStore } from '../src/state.js';
import { fakeLastfm, fakePlex, track, TEST } from './fakes.js';

async function setup({ tracks, loved, pageSize }) {
  const lf = await fakeLastfm({ loved });
  const px = await fakePlex({ tracks, pageSize });
  const dir = mkdtempSync(join(tmpdir(), 'plsync-'));
  const config = { plex: { sectionIds: undefined }, lastfm: { username: TEST.username }, reportDir: join(dir, 'reports') };
  const lastfm = createLastfm({ apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, username: TEST.username, baseUrl: lf.url, sleep: async () => {}, perSecond: 1000 });
  const plex = createPlex({ url: px.url, token: TEST.plexToken, pageDelayMs: 0 });
  const store = createMemoryStore();
  const out = [];
  const log = { out: (s) => out.push(s), info() {}, warn() {}, error() {} };
  const run = (name, o = {}) => runBulk({ name, rate: name === 'sync', allCopies: false, dryRun: false, confirm: async () => true, plex, lastfm, config, store, log, ...o });
  return { lf, px, store, out, run, dir, close: async () => { await lf.close(); await px.close(); } };
}

const library = () => [
  track('1', 'Artist A', 'Five Star Unloved', { rating: 10 }),
  track('2', 'Artist B', 'Five Star Loved', { rating: 10 }),
  track('3', 'Artist C', 'Loved Unrated'),                       // reverse: gets 5 stars
  track('4', 'Artist D', 'Loved But Three Stars', { rating: 6 }), // conflict: Plex wins
  track('5', 'Artist E', 'Not Loved Four Stars', { rating: 8 }),
  track('6', 'Artist F', 'Dupe', { album: 'Album 1' }),           // ambiguous
  track('7', 'Artist F', 'Dupe', { album: 'Greatest Hits' }),
  track('8', 'Beyoncé', "Don't Stop", { rating: 10 }),            // folds against the Last.fm spelling
];
const loved = () => [
  { artist: 'Artist B', title: 'Five Star Loved' },
  { artist: 'Artist C', title: 'Loved Unrated' },
  { artist: 'Artist D', title: 'Loved But Three Stars' },
  { artist: 'Artist F', title: 'Dupe' },
  { artist: 'Not In Plex', title: 'Unknown Song' },
  { artist: 'BEYONCE', title: 'Dont stop' },
];

test('backfill: loves only the 5-star tracks Last.fm lacks, and nothing else', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    const { plan, result } = await t.run('backfill');
    assert.deepEqual(plan.toLove.map((x) => x.title), ['Five Star Unloved']);
    assert.equal(plan.counts.toRate, 0);
    assert.equal(result.loved, 1);
    assert.equal(t.px.rated.length, 0, 'backfill never writes to Plex');
    assert.ok(t.lf.state.loved.some((l) => l.title === 'Five Star Unloved'));
    assert.equal(t.lf.calls.filter((c) => c.method === 'track.unlove').length, 0);
  } finally { await t.close(); }
});

test('sync: rates unrated loves, reports conflicts, ambiguity and unmatched, never changes a lower rating', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    const { plan, result } = await t.run('sync');
    assert.deepEqual(plan.counts, { plexTracks: 8, lastfmLoved: 6, toLove: 1, toRate: 1, conflicts: 1, ambiguous: 1, unmatched: 1, alreadyInSync: 2 });
    assert.deepEqual(t.px.rated, [{ key: '3', rating: 10 }]);
    assert.equal(t.px.store.get('4').userRating, 6, 'a 3-star Plex rating is kept');
    assert.equal(plan.conflicts[0].plexRating, 3);
    assert.equal(plan.unmatched[0].title, 'Unknown Song');
    assert.equal(result.failures.length, 0);
  } finally { await t.close(); }
});

test('a rerun after applying plans nothing (idempotent)', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    await t.run('sync');
    const callsBefore = t.lf.calls.filter((c) => c.method === 'track.love').length;
    const ratedBefore = t.px.rated.length;
    const second = await t.run('sync');
    assert.equal(second.plan.counts.toLove, 0);
    assert.equal(second.plan.counts.toRate, 0);
    assert.equal(second.result, null);
    assert.equal(t.lf.calls.filter((c) => c.method === 'track.love').length, callsBefore);
    assert.equal(t.px.rated.length, ratedBefore);
  } finally { await t.close(); }
});

test('dry run and a declined confirmation change nothing, but still print counts and write a report', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    for (const opts of [{ dryRun: true }, { confirm: async () => false }]) {
      const r = await t.run('sync', opts);
      assert.equal(r.result, null);
    }
    assert.equal(t.lf.calls.filter((c) => c.method === 'track.love').length, 0);
    assert.equal(t.px.rated.length, 0);
    assert.match(t.out.join('\n'), /To love on Last\.fm:\s+1/);
    assert.equal(readdirSync(join(t.dir, 'reports')).filter((f) => f.endsWith('.txt')).length, 2);
  } finally { await t.close(); }
});

test('--all-copies rates every unrated copy of an ambiguous loved track', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    const { plan } = await t.run('sync', { allCopies: true });
    assert.equal(plan.counts.ambiguous, 0);
    assert.deepEqual(t.px.rated.map((r) => r.key).sort(), ['3', '6', '7']);
  } finally { await t.close(); }
});

test('the report lists conflicts and unmatched tracks and holds no credential', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    const { report } = await t.run('sync');
    const text = readFileSync(report, 'utf8');
    assert.match(text, /Loved But Three Stars.*Plex: 3 stars/);
    assert.match(text, /Unknown Song.*not in Plex/);
    for (const v of [TEST.apiKey, TEST.sharedSecret, TEST.sessionKey, TEST.plexToken]) assert.ok(!text.includes(v));
  } finally { await t.close(); }
});

test('a Last.fm failure on one track is recorded and the run carries on', async () => {
  const t = await setup({ tracks: [track('1', 'A', 'One', { rating: 10 }), track('2', 'B', 'Two', { rating: 10 })], loved: [] });
  try {
    t.lf.state.failTitles.add('One'); // error 6: not retried
    const { result } = await t.run('backfill');
    assert.equal(result.failures.length, 1);
    assert.equal(result.loved, 1);
  } finally { await t.close(); }
});

test('Plex is read in pages, the token only in a header, and Plex is never asked for more than a page', async () => {
  const many = Array.from({ length: 450 }, (_, i) => track(String(1000 + i), `Artist ${i}`, `Title ${i}`));
  const t = await setup({ tracks: many, loved: [], pageSize: 200 });
  try {
    const { plan } = await t.run('backfill', { dryRun: true });
    assert.equal(plan.counts.plexTracks, 450);
    const pages = t.px.seenUrls.filter((u) => u.includes('/all?'));
    assert.equal(pages.length, 3);
    assert.ok(pages.every((u) => u.includes('X-Plex-Container-Size=200')));
    assert.ok(t.px.seenUrls.every((u) => !u.includes(TEST.plexToken)), 'token must not appear in a URL');
  } finally { await t.close(); }
});

test('only a love this run created is remembered; a hand-made love and a love that caused a rating are not', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    await t.run('sync');
    assert.deepEqual(t.store.entries().map(([k]) => k), ['1'], 'only "Five Star Unloved" was loved by the tool');
  } finally { await t.close(); }
});

test('the plan report exists, and lists what will change, before the confirmation is asked', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    let seen;
    await t.run('sync', { confirm: async () => { seen = readdirSync(join(t.dir, 'reports')).filter((f) => f.endsWith('-plan.txt')); return false; } });
    assert.equal(seen.length, 1);
    const text = readFileSync(join(t.dir, 'reports', seen[0]), 'utf8');
    assert.match(text, /To love on Last\.fm:\n\s+Artist A - Five Star Unloved/);
    assert.match(text, /To rate 5 stars in Plex:\n\s+Artist C - Loved Unrated/);
  } finally { await t.close(); }
});

test('a track rated in Plex after the plan was made is not overwritten', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    await t.run('sync', { confirm: async () => { t.px.store.get('3').userRating = 4; return true; } });
    assert.equal(t.px.store.get('3').userRating, 4);
    assert.deepEqual(t.px.rated, []);
  } finally { await t.close(); }
});

test('a "Various Artists" compilation matches on the track artist, and a longer artist name is not a match', async () => {
  const tracks = [track('1', 'X & Y', 'Song', { albumArtist: 'X' }), track('2', 'X', 'Other Song', { rating: 10 })];
  const t = await setup({ tracks, loved: [{ artist: 'X', title: 'Song' }] });
  try {
    const { plan } = await t.run('sync', { dryRun: true });
    assert.equal(plan.counts.toRate, 0);
    assert.equal(plan.unmatched[0].title, 'Song');
  } finally { await t.close(); }
});

test('a Plex library read that stops short fails instead of passing as complete', async () => {
  for (const opts of [{ omitTotal: true }, { totalOverride: 99 }]) {
    const lf = await fakeLastfm();
    const px = await fakePlex({ tracks: [track('1', 'A', 'One', { rating: 10 })], ...opts });
    try {
      const plex = createPlex({ url: px.url, token: TEST.plexToken, pageDelayMs: 0 });
      await assert.rejects(plex.allTracks('1'), /size|incomplete/);
    } finally { await lf.close(); await px.close(); }
  }
});

test('a Last.fm loved list that comes back short fails', async () => {
  const t = await setup({ tracks: library(), loved: loved() });
  try {
    t.lf.state.totalOverride = 500;
    await assert.rejects(t.run('backfill', { dryRun: true }), /incomplete/);
  } finally { await t.close(); }
});

test('a rating Plex returns as something other than a number is an error, never "unrated"', async () => {
  const px = await fakePlex({ tracks: [{ ratingKey: '1', type: 'track', title: 'T', grandparentTitle: 'A', userRating: 'ten' }] });
  try {
    const plex = createPlex({ url: px.url, token: TEST.plexToken, pageDelayMs: 0 });
    await assert.rejects(plex.allTracks('1'), /not a number/);
  } finally { await px.close(); }
});

test('bulk: every 5-star copy is remembered, so lowering one copy later cannot unlove the song', async () => {
  const t = await setup({ tracks: [track('1', 'A', 'Song', { rating: 10, album: 'X' }), track('2', 'A', 'Song', { rating: 10, album: 'Y' })], loved: [] });
  try {
    const { plan } = await t.run('backfill');
    assert.equal(plan.toLove.length, 1);
    assert.deepEqual(t.store.entries().map(([k]) => k).sort(), ['1', '2']);
  } finally { await t.close(); }
});

test('a track lowered in Plex between the plan and the love is not loved', async () => {
  const t = await setup({ tracks: [track('1', 'A', 'One', { rating: 10 }), track('2', 'B', 'Two', { rating: 10 })], loved: [] });
  try {
    const { result } = await t.run('backfill', { confirm: async () => { t.px.store.get('1').userRating = 4; return true; } });
    assert.equal(result.loved, 1);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(t.lf.state.loved, [{ artist: 'B', title: 'Two' }]);
  } finally { await t.close(); }
});

test('a Last.fm loved-list reply with no total or no list is an error, never "zero loves"', async () => {
  const lf = await fakeLastfm();
  const lastfm = createLastfm({ apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, username: TEST.username, baseUrl: lf.url, sleep: async () => {}, perSecond: 1000, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ lovedtracks: { track: [] } }) }) });
  const empty = createLastfm({ apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, username: TEST.username, baseUrl: lf.url, sleep: async () => {}, perSecond: 1000, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  try {
    await assert.rejects(lastfm.getLovedTracks(TEST.username), /how many/);
    await assert.rejects(empty.getLovedTracks(TEST.username), /no loved-tracks list/);
  } finally { await lf.close(); }
});

test('every request to Plex and Last.fm has a deadline and refuses redirects', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts); return { ok: true, status: 200, json: async () => ({ MediaContainer: { Directory: [], machineIdentifier: 'x' }, token: 't' }) }; };
  const plex = createPlex({ url: 'http://127.0.0.1:1', token: TEST.plexToken, fetchImpl });
  await plex.identity(); await plex.musicSections(); await plex.rate('1', 10);
  const lastfm = createLastfm({ apiKey: 'k', sharedSecret: 's', baseUrl: 'http://127.0.0.1:1/', fetchImpl, perSecond: 1000, sleep: async () => {} });
  await lastfm.getToken(); await lastfm.love('a', 'b');
  assert.equal(seen.length, 5);
  for (const o of seen) { assert.equal(o.redirect, 'error'); assert.ok(o.signal instanceof AbortSignal); }
});

test('ratings are written slowly so a sync does not flood its own listener', async () => {
  const t = await setup({ tracks: [track('1', 'A', 'One'), track('2', 'B', 'Two'), track('3', 'C', 'Three')], loved: [{ artist: 'A', title: 'One' }, { artist: 'B', title: 'Two' }, { artist: 'C', title: 'Three' }] });
  try {
    const { applyPlan } = await import('../src/sync.js');
    const { buildPlan } = await import('../src/sync.js');
    const config = { plex: {}, lastfm: { username: TEST.username } };
    const plan = await buildPlan({ plex: createPlex({ url: t.px.url, token: TEST.plexToken, pageDelayMs: 0 }), lastfm: createLastfm({ apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, username: TEST.username, baseUrl: t.lf.url, sleep: async () => {}, perSecond: 1000 }), config, rate: true });
    const pauses = [];
    await applyPlan({ plan, plex: createPlex({ url: t.px.url, token: TEST.plexToken, pageDelayMs: 0 }), lastfm: null, store: createMemoryStore(), log: { info() {} }, rateDelayMs: 250, sleep: async (ms) => { pauses.push(ms); } });
    assert.deepEqual(pauses, [250, 250, 250]);
  } finally { await t.close(); }
});

test('each copy is re-read before it is remembered: a copy lowered since the plan is not stored', async () => {
  const t = await setup({ tracks: [track('1', 'A', 'Song', { rating: 10, album: 'X' }), track('2', 'A', 'Song', { rating: 10, album: 'Y' })], loved: [] });
  try {
    await t.run('backfill', { confirm: async () => { t.px.store.get('2').userRating = 4; return true; } });
    assert.deepEqual(t.store.entries().map(([k]) => k), ['1']);
  } finally { await t.close(); }
});

test('an empty total in the Last.fm reply is an error, not zero', async () => {
  const lastfm = createLastfm({ apiKey: 'k', sharedSecret: 's', username: 'u', baseUrl: 'http://127.0.0.1:1/', perSecond: 1000, sleep: async () => {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ lovedtracks: { track: [], '@attr': { total: '', totalPages: '1' } } }) }) });
  await assert.rejects(lastfm.getLovedTracks('u'), /how many/);
});
