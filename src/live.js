import { otherCopy } from './state.js';
import { trackKey } from './match.js';

// What a rating change does on Last.fm. Plex is the source of truth: the rating is read back from Plex,
// never taken from the webhook body alone.
export const FIVE_STARS = 10;

// A remembered entry belongs to the track Plex returns now only if artist and title still agree.
// After a library rebuild a rating key can be reused for a different track.
const sameTrack = (entry, track) => {
  const a = trackKey(entry.artist, entry.title);
  return a !== null && a === trackKey(track.artist, track.title);
};

export async function applyRating({ track, lastfm, store }) {
  let known = store.get(track.ratingKey);
  if (known && !sameTrack(known, track)) { store.del(track.ratingKey); known = undefined; } // stale: forget it, unlove nothing
  const mine = { artist: track.artist, title: track.title };
  if (track.rating === FIVE_STARS) {
    if (known) {
      await lastfm.love(known.artist, known.title); // idempotent: makes sure it is still loved
      return { action: 'love' };
    }
    // Another copy of this song is already the tool's love: love again and remember this copy too, so lowering
    // one copy does not unlove a song whose other copy is still 5 stars. No question to Last.fm needed.
    if (otherCopy(store, track.ratingKey, mine)) {
      await lastfm.love(track.artist, track.title);
      store.set(track.ratingKey, mine);
      return { action: 'love' };
    }
    // Last.fm answers "not found" for a track it has no page for. Such a track cannot be loved yet, so love it
    // and remember it. (The username is checked at start-up, so "not found" cannot mean a wrong account.)
    let loved = false;
    try { loved = await lastfm.isLoved(track.artist, track.title); } catch (e) { if (e.code !== 6) throw e; }
    if (loved) return { action: 'already-loved' }; // a hand-made love: never remembered, never unloved
    await lastfm.love(track.artist, track.title);
    store.set(track.ratingKey, mine);
    return { action: 'love' };
  }
  if (known) {
    const stillFiveStarElsewhere = otherCopy(store, track.ratingKey, known);
    if (!stillFiveStarElsewhere) await lastfm.unlove(known.artist, known.title);
    store.del(track.ratingKey);
    return { action: stillFiveStarElsewhere ? 'kept (another copy is 5 stars)' : 'unlove' };
  }
  return { action: 'none' };
}
