import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, trackKey } from '../src/match.js';

test('case, accents, punctuation and ampersands fold together', () => {
  assert.equal(trackKey('Beyoncé', "Don't Hurt Yourself!"), trackKey('BEYONCE', 'Dont hurt yourself'));
  assert.equal(trackKey('Simon & Garfunkel', 'The Boxer'), trackKey('Simon and Garfunkel', 'the boxer'));
  assert.equal(fold('Mötley   Crüe'), 'motley crue');
});

test('different songs and different artists never match', () => {
  assert.notEqual(trackKey('A', 'Song'), trackKey('B', 'Song'));
  assert.notEqual(trackKey('A', 'Song (Live)'), trackKey('A', 'Song'));
});

test('an empty artist or title has no key', () => {
  assert.equal(trackKey('', 'x'), null);
  assert.equal(trackKey('x', '!!!'), null);
});
