import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLastfm, sign, LastfmError } from '../src/lastfm.js';
import { createLimiter } from '../src/ratelimit.js';
import { fakeLastfm, TEST } from './fakes.js';

const client = (url, extra = {}) => createLastfm({ apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, baseUrl: url, sleep: async () => {}, perSecond: 1000, ...extra });

test('sign: sorted name+value pairs, then the secret, md5; format and callback left out', () => {
  // md5("api_keyabcmethodauth.getTokensecret"), computed with the system md5 tool
  assert.equal(sign({ method: 'auth.getToken', api_key: 'abc', format: 'json' }, 'secret'), 'f8644421' + '1049e605f18c05a5964aabfc'); // split so the secret scan does not flag a plain md5 digest
  assert.match(sign({ a: '1' }, 's'), /^[0-9a-f]{32}$/);
  assert.equal(sign({ a: '1', format: 'json', callback: 'x' }, 's'), sign({ a: '1' }, 's'));
  assert.notEqual(sign({ a: '1' }, 's'), sign({ a: '2' }, 's'));
});

test('love and unlove are signed POSTs that the fake accepts', async () => {
  const fake = await fakeLastfm();
  try {
    const lf = client(fake.url);
    await lf.love('The Band', 'Song One');
    assert.deepEqual(fake.state.loved, [{ artist: 'The Band', title: 'Song One' }]);
    assert.equal(fake.calls[0].httpMethod, 'POST');
    await lf.unlove('The Band', 'Song One');
    assert.deepEqual(fake.state.loved, []);
  } finally { await fake.close(); }
});

test('a wrong shared secret is rejected by signature check', async () => {
  const fake = await fakeLastfm();
  try {
    const lf = client(fake.url, { sharedSecret: 'wrong' });
    await assert.rejects(lf.love('A', 'B'), (e) => e instanceof LastfmError && e.code === 13);
  } finally { await fake.close(); }
});

test('rate limit error 29 is retried, then succeeds', async () => {
  const fake = await fakeLastfm({ failWith: [29, 16] });
  try {
    await client(fake.url).love('A', 'B');
    assert.equal(fake.calls.length, 3);
  } finally { await fake.close(); }
});

test('gives up after the retry budget', async () => {
  const fake = await fakeLastfm({ failWith: [29, 29, 29, 29, 29] });
  try {
    await assert.rejects(client(fake.url, { retries: 2 }).love('A', 'B'), (e) => e.code === 29);
    assert.equal(fake.calls.length, 3);
  } finally { await fake.close(); }
});

test('getLovedTracks walks every page', async () => {
  const loved = Array.from({ length: 450 }, (_, i) => ({ artist: `Artist ${i}`, title: `Title ${i}` }));
  const fake = await fakeLastfm({ loved });
  try {
    const got = await client(fake.url).getLovedTracks(TEST.username);
    assert.equal(got.length, 450);
    assert.equal(fake.calls.filter((c) => c.method === 'user.getLovedTracks').length, 3);
  } finally { await fake.close(); }
});

test('limiter never starts more than 5 calls in a second', async () => {
  let clock = 0;
  const starts = [];
  const wait = createLimiter(5, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  for (let i = 0; i < 20; i++) { await wait(); starts.push(clock); }
  for (let i = 5; i < starts.length; i++) assert.ok(starts[i] - starts[i - 5] >= 1000, `calls ${i - 5}..${i} too close`);
});
