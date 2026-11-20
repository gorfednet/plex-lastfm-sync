import { trackKey } from './match.js';
import { FIVE_STARS } from './live.js';

const unrated = (t) => !t.rating;

// Reads Plex and Last.fm and works out what a bulk run would change. Changes nothing.
//   love:   every track rated 5 stars in Plex that Last.fm does not list as loved.
//   rate:   (full sync) every Last.fm love that is unrated in Plex gets 5 stars. A love on a track Plex rates
//           lower is a conflict: reported, never changed, because the Plex rating wins.
// A track is matched on its track artist (Plex `originalTitle` when set, else the album artist) and its title.
export async function buildPlan({ plex, lastfm, config, rate = false, allCopies = false }) {
  const sections = config.plex.sectionIds ?? (await plex.musicSections()).map((s) => s.key);
  if (sections.length === 0) throw new Error('No music library found in Plex.');
  const tracks = [];
  for (const s of sections) tracks.push(...(await plex.allTracks(s)));
  const loved = await lastfm.getLovedTracks(config.lastfm.username);

  const index = new Map();
  for (const t of tracks) {
    const k = trackKey(t.artist, t.title);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(t);
  }
  const lovedKeys = new Set(loved.map((l) => trackKey(l.artist, l.title)).filter(Boolean));

  const plan = { toLove: [], toRate: [], conflicts: [], ambiguous: [], unmatched: [], inSync: 0, counts: {} };
  const loveByKey = new Map();
  for (const t of tracks) {
    if (t.rating !== FIVE_STARS) continue;
    const k = trackKey(t.artist, t.title);
    if (!k) { plan.unmatched.push({ side: 'plex', artist: t.artist, title: t.title, reason: 'empty artist or title' }); continue; }
    if (lovedKeys.has(k)) { plan.inSync++; continue; }
    // Every 5-star copy of the song is remembered once the love is made, so lowering one copy can't unlove the others.
    if (loveByKey.has(k)) { loveByKey.get(k).ratingKeys.push(t.ratingKey); continue; }
    const entry = { ratingKeys: [t.ratingKey], artist: t.artist, title: t.title, album: t.album };
    loveByKey.set(k, entry);
    plan.toLove.push(entry);
  }

  if (rate) {
    for (const l of loved) {
      const k = trackKey(l.artist, l.title);
      const candidates = k ? (index.get(k) ?? []) : [];
      if (candidates.length === 0) { plan.unmatched.push({ side: 'lastfm', artist: l.artist, title: l.title, reason: 'not in Plex' }); continue; }
      if (candidates.some((c) => c.rating === FIVE_STARS)) continue; // already agrees
      const rated = candidates.filter((c) => !unrated(c));
      if (rated.length > 0) {
        plan.conflicts.push({ artist: l.artist, title: l.title, plexRating: Math.max(...rated.map((c) => c.rating)) / 2 });
        continue;
      }
      if (candidates.length > 1 && !allCopies) {
        plan.ambiguous.push({ artist: l.artist, title: l.title, copies: candidates.map((c) => c.album) });
        continue;
      }
      for (const c of candidates) plan.toRate.push({ ratingKey: c.ratingKey, artist: c.artist, title: c.title, album: c.album });
    }
  }

  plan.counts = {
    plexTracks: tracks.length,
    lastfmLoved: loved.length,
    toLove: plan.toLove.length,
    toRate: plan.toRate.length,
    conflicts: plan.conflicts.length,
    ambiguous: plan.ambiguous.length,
    unmatched: plan.unmatched.length,
    alreadyInSync: plan.inSync,
  };
  return plan;
}

export function summarize(plan, { rate }) {
  const c = plan.counts;
  const lines = [
    `Plex tracks read:        ${c.plexTracks}`,
    `Last.fm loved tracks:    ${c.lastfmLoved}`,
    `5-star, already loved:   ${c.alreadyInSync}`,
    `To love on Last.fm:      ${c.toLove}`,
  ];
  if (rate) {
    lines.push(`To rate 5 stars in Plex: ${c.toRate}`);
    lines.push(`Conflicts (reported only, Plex rating kept): ${c.conflicts}`);
    lines.push(`Ambiguous (several copies, left alone):      ${c.ambiguous}`);
  }
  lines.push(`Unmatched (listed in the report):            ${c.unmatched}`);
  return lines.join('\n');
}

// Applies a plan. Safe to rerun: a second run plans nothing new.
// Only a love this run created is remembered, so only that love can later be unloved.
// A rating is re-checked just before it is acted on: a track changed in Plex since the plan was made is left alone.
// Ratings are written slowly, because each write may make Plex send this tool's own listener a webhook.
export async function applyPlan({ plan, plex, lastfm, store, log, rateDelayMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const result = { loved: 0, rated: 0, skipped: [], failures: [] };
  let batch = {};
  const flush = () => { if (Object.keys(batch).length) { store.setMany(batch); batch = {}; } };
  try {
    for (const t of plan.toLove) {
      try {
        // Re-read every copy: remember only the ones that are still 5 stars.
        const live = [];
        for (const key of t.ratingKeys) { const now = await plex.track(key); if (now && now.rating === FIVE_STARS) live.push(key); }
        if (live.length === 0) { result.skipped.push({ artist: t.artist, title: t.title, reason: 'no longer 5 stars in Plex' }); continue; }
        await lastfm.love(t.artist, t.title);
        for (const key of live) batch[key] = { artist: t.artist, title: t.title };
        result.loved++;
      } catch (e) { result.failures.push({ action: 'love', artist: t.artist, title: t.title, error: e.message }); }
      if (Object.keys(batch).length >= 50) flush();
    }
  } finally { flush(); }
  for (const t of plan.toRate) {
    try {
      const now = await plex.track(t.ratingKey);
      if (!now || now.rating) { result.skipped.push({ artist: t.artist, title: t.title, reason: 'rated in Plex since the plan was made' }); continue; }
      await plex.rate(t.ratingKey, FIVE_STARS);
      result.rated++;
      if (rateDelayMs) await sleep(rateDelayMs);
    } catch (e) { result.failures.push({ action: 'rate', artist: t.artist, title: t.title, error: e.message }); }
  }
  log.info('bulk run applied', { loved: result.loved, rated: result.rated, skipped: result.skipped.length, failures: result.failures.length });
  return result;
}
