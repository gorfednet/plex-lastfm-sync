import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, writeConfig, isPrivateBindAddress, validate, resolveConfigPath, newPathToken, ConfigError } from '../src/config.js';
import { TEST } from './fakes.js';

const good = () => ({
  lastfm: { apiKey: TEST.apiKey, sharedSecret: TEST.sharedSecret, sessionKey: TEST.sessionKey, username: TEST.username },
  plex: { url: 'http://127.0.0.1:32400', token: TEST.plexToken, serverUuid: TEST.serverUuid },
  listener: { host: '127.0.0.1', port: 18094, pathToken: TEST.pathToken },
  stateFile: '/var/lib/x/state.json',
  reportDir: '/var/lib/x/reports',
});

test('bind address: loopback, private and Tailscale pass; wildcard and public fail', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.10', '100.64.0.1', '100.64.0.2', '::1', 'fd7a:115c:a1e0::1', 'localhost']) assert.ok(isPrivateBindAddress(ok), ok);
  for (const bad of ['0.0.0.0', '::', '8.8.8.8', '172.32.0.1', '100.128.0.1', '100.63.0.1', '2001:db8::1', '', 'example.com', '192.169.0.1']) assert.ok(!isPrivateBindAddress(bad), bad);
});

test('validate refuses a wildcard listener and a short path token', () => {
  const a = good(); a.listener.host = '0.0.0.0';
  assert.throws(() => validate(a), ConfigError);
  const b = good(); b.listener.pathToken = 'short';
  assert.throws(() => validate(b), ConfigError);
  const c = good(); delete c.lastfm.apiKey;
  assert.throws(() => validate(c), /apiKey/);
});

test('a session is required only when asked for', () => {
  const raw = good(); delete raw.lastfm.sessionKey;
  assert.doesNotThrow(() => validate(raw));
  assert.throws(() => validate(raw, { requireSession: true }), /auth/);
});

test('loadConfig refuses a file readable by group or others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plsync-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(good()));
  chmodSync(p, 0o640);
  assert.throws(() => loadConfig(p), /mode 600/);
  chmodSync(p, 0o600);
  assert.equal(loadConfig(p).config.plex.serverUuid, TEST.serverUuid);
});

test('writeConfig creates mode 600 and leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plsync-'));
  const p = join(dir, 'nested', 'config.json');
  writeConfig(p, good());
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['config.json']);
});

test('the config path comes from the env var or --config, or it is an error', () => {
  assert.equal(resolveConfigPath(undefined, { PLEX_LASTFM_CONFIG: '/x' }), '/x');
  assert.equal(resolveConfigPath('/y', { PLEX_LASTFM_CONFIG: '/x' }), '/y');
  assert.throws(() => resolveConfigPath(undefined, {}), ConfigError);
});

test('path tokens are long and random', () => {
  const a = newPathToken(), b = newPathToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test('state and report paths must be absolute', () => {
  const a = good(); a.stateFile = 'state.json';
  assert.throws(() => validate(a), /absolute/);
  const b = good(); delete b.reportDir;
  assert.throws(() => validate(b), /absolute/);
});

test('lastfm.apiUrl accepts only the real API or loopback, and never embedded credentials', () => {
  for (const ok of ['https://ws.audioscrobbler.com/2.0/', 'http://127.0.0.1:5000/2.0/', 'http://localhost:5000/']) {
    const c = good(); c.lastfm.apiUrl = ok;
    assert.doesNotThrow(() => validate(c), ok);
  }
  for (const bad of ['http://127.0.0.1:80@evil.example/', 'https://ws.audioscrobbler.com.evil.example/', 'http://evil.example/', 'https://user:pw@ws.audioscrobbler.com/', 'ftp://127.0.0.1/', 'nonsense']) {
    const c = good(); c.lastfm.apiUrl = bad;
    assert.throws(() => validate(c), ConfigError, bad);
  }
});
