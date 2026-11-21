import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { fakeLastfm, fakePlex, track, TEST } from './fakes.js';

const BIN = new URL('../bin/plex-lastfm-sync.js', import.meta.url).pathname;
const fixture = JSON.parse(read(new URL('./fixtures/media.rate.json', import.meta.url), 'utf8'));
const ALL = [TEST.apiKey, TEST.sharedSecret, TEST.sessionKey, TEST.plexToken];


// Async on purpose: the fake servers live in this process, so a blocking spawn would deadlock.
function run(args, envVars, { stdin = 'ignore', input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...envVars }, stdio: [stdin, 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
    if (input !== undefined) p.stdin.end(input);
  });
}

async function env(port) {
  const lf = await fakeLastfm();
  const px = await fakePlex({ tracks: [track('101', 'The Band', 'Song One', { rating: 10 }), track('102', 'The Band', 'Song Two', { rating: 10 })] });
  const dir = mkdtempSync(join(tmpdir(), 'plsync-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({
    lastfm: { apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, username: TEST.username, apiUrl: lf.url },
    plex: { url: px.url, token: TEST.plexToken, serverUuid: TEST.serverUuid, pageDelayMs: 0 },
    listener: { host: '127.0.0.1', port, pathToken: TEST.pathToken },
    stateFile: join(dir, 'state.json'), reportDir: join(dir, 'reports'),
  }), { mode: 0o600 });
  return { lf, px, dir, cfg, close: async () => { await lf.close(); await px.close(); } };
}

test('backfill --yes through the real CLI loves the 5-star tracks and prints no credential', async () => {
  const e = await env(18999);
  try {
    const r = await run(['backfill', '--yes'], { ...process.env, PLEX_LASTFM_CONFIG: e.cfg });
    assert.equal(r.status, 0, r.out);
    assert.equal(e.lf.state.loved.length, 2);
    for (const v of ALL) assert.ok(!r.out.includes(v));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(e.dir, 'state.json'), 'utf8')).fiveStar).sort(), ['101', '102']);
  } finally { await e.close(); }
});

test('backfill without --yes and without a terminal applies nothing', async () => {
  const e = await env(18999);
  try {
    const r = await run(['backfill'], { ...process.env, PLEX_LASTFM_CONFIG: e.cfg });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Not applying/);
    assert.equal(e.lf.state.loved.length, 0);
  } finally { await e.close(); }
});

test('serve: a posted webhook loves the track on Last.fm within a second', async () => {
  const port = 18000 + Math.floor(Math.random() * 900);
  const e = await env(port);
  const p = spawn(process.execPath, [BIN, 'serve'], { env: { ...process.env, PLEX_LASTFM_CONFIG: e.cfg } });
  let log = '';
  p.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 50 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(log, /listening/);
    const boundary = 'b123';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(fixture)}\r\n--${boundary}--\r\n`;
    const res = await fetch(`http://127.0.0.1:${port}/hook/${TEST.pathToken}`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    assert.equal(res.status, 200);
    for (let i = 0; i < 30 && e.lf.state.loved.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(e.lf.state.loved, [{ artist: 'The Band', title: 'Song One' }]);
    for (const v of [...ALL, TEST.pathToken]) assert.ok(!log.includes(v), 'secret in log');
  } finally { p.kill('SIGTERM'); await e.close(); }
});

test('a config readable by others stops every command', async () => {
  const e = await env(18999);
  try {
    chmodSync(e.cfg, 0o644);
    const r = await run(['serve'], { ...process.env, PLEX_LASTFM_CONFIG: e.cfg });
    assert.equal(r.status, 78, 'a config error exits 78 so the unit does not restart it');
    assert.match(r.stderr, /mode 600/);
  } finally { await e.close(); }
});

test('webhook-url prints the listener URL, and only that command prints the path token', async () => {
  const e = await env(18999);
  try {
    const r = await run(['webhook-url'], { ...process.env, PLEX_LASTFM_CONFIG: e.cfg });
    assert.equal(r.stdout.trim(), `http://127.0.0.1:18999/hook/${TEST.pathToken}`);
  } finally { await e.close(); }
});

test('no config path is a clear error', async () => {
  const r = await run(['serve'], { PATH: process.env.PATH });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /PLEX_LASTFM_CONFIG/);
});

test('auth prints the approval URL, then stores the session key in a mode-600 file without printing it', async () => {
  const e = await env(18999);
  try {
    const raw = JSON.parse(readFileSync(e.cfg, 'utf8'));
    delete raw.lastfm.sessionKey; delete raw.lastfm.username;
    writeFileSync(e.cfg, JSON.stringify(raw), { mode: 0o600 });
    const r = await run(['auth'], { ...process.env, PLEX_LASTFM_CONFIG: e.cfg }, { stdin: 'pipe', input: '\n' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /last\.fm\/api\/auth\/\?api_key=.*&token=test-auth-token/);
    const after = JSON.parse(readFileSync(e.cfg, 'utf8'));
    assert.equal(after.lastfm.sessionKey, TEST.sessionKey);
    assert.equal(after.lastfm.username, TEST.username);
    assert.equal(statSync(e.cfg).mode & 0o777, 0o600);
    assert.ok(!r.out.includes(TEST.sessionKey) && !r.out.includes(TEST.sharedSecret));
  } finally { await e.close(); }
});

test('--config before the command still serves (the process stays up)', async () => {
  const port = 18000 + Math.floor(Math.random() * 900);
  const e = await env(port);
  const p = spawn(process.execPath, [BIN, '--config', e.cfg, 'serve'], { env: { PATH: process.env.PATH } });
  let log = '', exited = false;
  p.stderr.on('data', (d) => (log += d));
  p.on('exit', () => { exited = true; });
  try {
    for (let i = 0; i < 50 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    assert.match(log, /listening/);
    assert.equal(exited, false);
  } finally { p.kill('SIGTERM'); await e.close(); }
});

test('serve refuses to start on a damaged state file and leaves it untouched', async () => {
  const e = await env(18999);
  try {
    const sf = join(e.dir, 'state.json');
    writeFileSync(sf, '{ broken');
    const r = await run(['serve'], { ...process.env, PLEX_LASTFM_CONFIG: e.cfg });
    assert.equal(r.status, 78, 'a damaged state file is a configuration error: the unit must not restart it');
    assert.match(r.stderr, /unreadable/);
    assert.equal(readFileSync(sf, 'utf8'), '{ broken');
  } finally { await e.close(); }
});

test('--help prints the usage and exits 0', async () => {
  const r = await run(['--help'], { ...process.env });
  assert.equal(r.status, 0);
  assert.match(r.out, /plex-lastfm-sync <command>/);
});

test('a bare invocation prints the usage and exits 1', async () => {
  const r = await run([], { ...process.env });
  assert.equal(r.status, 1);
  assert.match(r.out, /plex-lastfm-sync <command>/);
});

test('serve and bulk refuse to run when the Last.fm session belongs to a different account', async () => {
  const e = await env(18999);
  try {
    e.lf.state.sessionUser = 'someone-else';
    for (const cmd of [['serve'], ['backfill', '--yes']]) {
      const r = await run(cmd, { ...process.env, PLEX_LASTFM_CONFIG: e.cfg });
      assert.equal(r.status, 78, cmd.join(' '));
      assert.match(r.stderr, /does not belong to the configured username/);
    }
    assert.equal(e.lf.calls.filter((c) => c.method === 'track.love').length, 0);
  } finally { await e.close(); }
});
