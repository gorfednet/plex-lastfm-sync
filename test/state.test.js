import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/state.js';

test('two processes writing the same state file keep each other\'s entries', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'plsync-')), 'state.json');
  const listener = createFileStore(p);
  const bulk = createFileStore(p);
  listener.set('1', { artist: 'A', title: 'One' });
  bulk.set('2', { artist: 'B', title: 'Two' }); // a bulk run adds entries while the listener is up
  listener.set('3', { artist: 'C', title: 'Three' }); // the listener's next save must not erase entry 2
  assert.deepEqual(createFileStore(p).entries().map(([k]) => k).sort(), ['1', '2', '3']);
  listener.del('1');
  assert.deepEqual(bulk.entries().map(([k]) => k).sort(), ['2', '3']);
});

test('a damaged state file is an error, never an empty memory', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'plsync-')), 'state.json');
  writeFileSync(p, '{ not json');
  const s = createFileStore(p);
  assert.throws(() => s.check(), /unreadable/);
  assert.throws(() => s.set('1', { artist: 'A', title: 'B' }), /unreadable/);
});

test('a missing state file is an empty memory; writes are mode 600 and leave no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plsync-'));
  const p = join(dir, 'sub', 'state.json');
  const s = createFileStore(p);
  s.check();
  s.set('1', { artist: 'A', title: 'B' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['state.json']);
});
