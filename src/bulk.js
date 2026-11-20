import { buildPlan, applyPlan, summarize } from './sync.js';
import { writeReport } from './report.js';

// A bulk run is always a dry run first: it prints the counts and writes the plan report, then applies only when told to.
// `confirm` is asked after that; it returns true to apply.
export async function runBulk({ name, rate, allCopies, dryRun, confirm, plex, lastfm, config, store, log }) {
  const plan = await buildPlan({ plex, lastfm, config, rate, allCopies });
  const planReport = writeReport(config.reportDir, name, plan, null, { rate });
  log.out('Dry run:\n' + summarize(plan, { rate }) + `\nPlan report: ${planReport}`);
  const nothing = plan.toLove.length === 0 && plan.toRate.length === 0;
  if (dryRun || nothing || !(await confirm(plan))) {
    log.out(nothing ? 'Nothing to change.' : 'Nothing was changed.');
    return { plan, result: null, report: planReport };
  }
  const result = await applyPlan({ plan, plex, lastfm, store, log, rateDelayMs: config.plex.rateDelayMs ?? 0 });
  const file = writeReport(config.reportDir, name, plan, result, { rate });
  log.out(`Applied: ${result.loved} loved, ${result.rated} rated, ${result.skipped.length} skipped, ${result.failures.length} failed. Report: ${file}`);
  return { plan, result, report: file };
}
