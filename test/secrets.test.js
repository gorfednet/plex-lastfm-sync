import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { registerSecret, scrub } from '../src/logger.js';

test('the logger scrubs a registered secret, raw and URL-encoded', () => {
  registerSecret('s3cr3t value/+=');
  assert.equal(scrub('x s3cr3t value/+= y'), 'x [redacted] y');
  assert.equal(scrub(`x ${encodeURIComponent('s3cr3t value/+=')} y`), 'x [redacted] y');
});

// Fails if a file in the repository looks like it holds a real credential.
// Test values are made up and spell out what they are ("test-...").
const PATTERNS = [
  [/\b[0-9a-f]{32,}\b/, 'a 32-character or longer hex string (Last.fm key, secret or session key, Plex server ID)'],
  [/\b(apiKey|sharedSecret|sessionKey|token|pathToken|secret|password)\b['"]?\s*[:=]\s*['"](?!test-|REPLACE|TEST\b)[A-Za-z0-9_\-+/=]{16,}['"]/i, 'a credential assigned a real-looking value'],
  [/X-Plex-Token=[A-Za-z0-9_-]{15,}/i, 'a Plex token in a URL'],
  [/"(apiKey|sharedSecret|sessionKey|token|pathToken)"\s*:\s*"(?!test-|REPLACE|")[^"]{12,}"/, 'a credential field with a real-looking value'],
  [/\/hook\/[A-Za-z0-9_-]{32,}/, 'a webhook address with its secret path'],
  [/x-plex-token['"]?\s*:\s*['"]?(?!test-)[A-Za-z0-9_-]{15,}/i, 'a Plex token in header form'],
  [/\b(sk|api_key|api_sig)=(?!test-)[A-Za-z0-9]{16,}/, 'a Last.fm request value'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

export function findSecrets(files, read = (f) => readFileSync(f, 'utf8')) {
  const hits = [];
  for (const f of files) {
    if (f === 'test/secrets.test.js') continue; // holds the patterns themselves
    let text;
    try { text = read(f); } catch { continue; }
    text = text.replace(/@[0-9a-f]{40}\b/g, '@PINNED'); // commit SHAs that pin CI actions
    for (const [re, what] of PATTERNS) if (re.test(text)) hits.push(`${f}: ${what}`);
  }
  return hits;
}

test('no tracked file holds a credential-shaped string', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 10, 'expected the repository file list');
  assert.deepEqual(findSecrets(files), []);
});

test('the secret scan catches each pattern (near-miss negatives pass)', () => {
  const bad = ['0123456789abcdef0123456789abcdef', 'x?X-Plex-Token=abcdefghijklmnopqrst', '{"apiKey": "realvalue123456"}', "const token = 'abcdefghijklmnopqrstu'", 'x'.repeat(0) + '0123456789abcdef0123456789abcdef01234567', 'ghp_' + 'a'.repeat(36), '-----BEGIN RSA PRIVATE KEY-----'];
  for (const b of bad) assert.ok(findSecrets(['f'], () => b).length >= 1, b);
  const fine = ['{"apiKey": "test-api-key-0001"}', '{"apiKey": ""}', 'abcdef0123', 'X-Plex-Token header', '{"apiKey": "REPLACE_ME_PLEASE"}'];
  for (const g of fine) assert.deepEqual(findSecrets(['f'], () => g), [], g);
});

// A payload captured from a live server carries the home IP, the account name and avatar, and the real server ID.
// Every identifying field in a fixture must hold an obviously fake value.
const IDENTITY_KEYS = new Set(['title', 'thumb', 'uuid', 'publicAddress', 'machineIdentifier', 'name', 'email', 'username']);
const FAKE = /^(test-|https:\/\/example\.invalid\/|203\.0\.113\.\d+$|Plexamp$)/;

export function identifyingValues(node, path = '') {
  const bad = [];
  if (Array.isArray(node)) node.forEach((v, i) => bad.push(...identifyingValues(v, `${path}[${i}]`)));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const where = `${path}.${k}`;
      const inIdentity = /^\.(Account|Server|Player)\./.test(where);
      if (typeof v === 'string' && inIdentity && IDENTITY_KEYS.has(k) && !FAKE.test(v)) bad.push(where);
      else bad.push(...identifyingValues(v, where));
    }
  }
  return bad;
}

test('every webhook fixture holds only fake identifying values', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(names.length >= 1);
  for (const n of names) assert.deepEqual(identifyingValues(JSON.parse(readFileSync(new URL(n, dir), 'utf8'))), [], n);
});

test('the fixture check catches a captured payload (near-miss: fake values pass)', () => {
  const captured = { Account: { title: 'someone', thumb: 'https://plex.tv/users/abc/avatar' }, Server: { uuid: 'a1b2c3d4e5' }, Player: { publicAddress: '198.51.100.9' } };
  assert.equal(identifyingValues(captured).length, 4);
  assert.deepEqual(identifyingValues({ Account: { title: 'test-owner', thumb: 'https://example.invalid/a.png' }, Server: { uuid: 'test-x' }, Player: { publicAddress: '203.0.113.7', title: 'Plexamp' } }), []);
});

test('the scan also catches a pasted webhook address, a header-form Plex token and a signed-request value', () => {
  for (const b of [`http://127.0.0.1:18094/hook/${'A'.repeat(43)}`, 'X-Plex-Token: abcdefghijklmnopqrst', 'sk=abcdefghijklmnop1234', 'api_key=abcdefghijklmnop1234']) {
    assert.ok(findSecrets(['f'], () => b).length >= 1, b);
  }
  for (const g of ['/hook/ followed by a token', 'api_key=test-api-key-0001', 'sk=test-session-key-0003']) assert.deepEqual(findSecrets(['f'], () => g), [], g);
});
