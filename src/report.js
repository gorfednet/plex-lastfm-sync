import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize } from './sync.js';

const line = (x) => `  ${x.artist} - ${x.title}${x.album ? ` [${x.album}]` : ''}${x.plexRating ? ` (Plex: ${x.plexRating} stars)` : ''}${x.reason ? ` (${x.reason})` : ''}${x.error ? ` (${x.error})` : ''}`;

// Writes the run's report (counts and every list) to the report directory, as text and JSON.
// It holds track names and counts only. `stage` is "plan" before anything is applied, "applied" after.
export function writeReport(dir, name, plan, result, { rate }, stage = result ? 'applied' : 'plan') {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(dir, `${stamp}-${name}-${stage}`);
  const payload = { when: new Date().toISOString(), stage, counts: plan.counts, result: result ?? null, toLove: plan.toLove, toRate: plan.toRate, conflicts: plan.conflicts, ambiguous: plan.ambiguous, unmatched: plan.unmatched };
  writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  const txt = [summarize(plan, { rate }), '', result ? `Applied: ${result.loved} loved, ${result.rated} rated, ${result.skipped.length} skipped, ${result.failures.length} failed.` : 'Plan only. Nothing has been changed.'];
  for (const [title, list] of [
    ['To love on Last.fm', result ? [] : plan.toLove], ['To rate 5 stars in Plex', result ? [] : plan.toRate],
    ['Conflicts', plan.conflicts], ['Ambiguous', plan.ambiguous], ['Unmatched', plan.unmatched],
    ['Skipped', result?.skipped ?? []], ['Failures', result?.failures ?? []],
  ]) if (list.length) txt.push('', `${title}:`, ...list.map(line));
  writeFileSync(`${base}.txt`, txt.join('\n') + '\n', { mode: 0o600 });
  return `${base}.txt`;
}
