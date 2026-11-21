# Changelog

Every release of plex-lastfm-sync is listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 1.0.0 - 2026-11-20

The first release. It keeps Plex 5-star ratings and Last.fm loves in sync in both directions.

### Added

- Live listener (`serve`). A 5-star rating in Plex loves the track on Last.fm. Lowering the rating removes a love the tool made.
- `backfill` command. Loves every 5-star Plex track that Last.fm doesn't list yet.
- `sync` command. Runs the backfill, then gives 5 stars in Plex to each Last.fm love that Plex leaves unrated.
- Conflict handling. A Plex rating below 5 stars is kept and reported. Plex wins every disagreement.
- Dry run before every bulk run, with a plan report and an applied report as text and JSON
- `--dry-run`, `--yes` and `--all-copies` options for bulk runs
- Matching on artist and title, with case, accents, punctuation and "&" versus "and" folded
- `init`, `auth` and `webhook-url` commands for setup. `init` takes secrets at hidden prompts.
- Webhook listener that binds only to a loopback, private or Tailscale address, behind a secret path
- Config file that must be mode 600 and owned by the user running the tool
- Log lines scrubbed of the configured secrets
- Load limits: 5 Last.fm calls a second, Plex read in pages of 200 tracks and 250 ms between rating writes
- systemd unit in `deploy/`, limited to 128 MB of memory and 20% of 1 CPU
- No runtime dependencies. Runs on Node.js 22 or newer.
