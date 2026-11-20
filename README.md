# plex-lastfm-sync

Rate a track 5 stars in Plexamp and it's loved on Last.fm within a minute.

- **Live.** A Plex webhook tells a small listener about each rating. A 5-star rating loves the track. Dropping below 5 stars unloves it.
- **Backfill.** Loves every 5-star track in Plex that Last.fm doesn't list yet.
- **Full sync.** Also gives 5 stars in Plex to any track you loved on Last.fm and never rated. Plex wins every disagreement.
- **No dependencies.** Plain Node.js 22 or newer. Nothing to install from npm.

## What it needs

- Plex Media Server with a Plex Pass. Plex only sends webhooks to Pass accounts.
- A Last.fm API account: [last.fm/api/account/create](https://www.last.fm/api/account/create). Any name works. Leave the callback URL empty.
- Your Plex token. Plex's guide to [finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) shows how.
- A Linux host that runs next to Plex, with Node.js 22 or newer and systemd. Other setups work. The unit file is the only systemd part.

## Set up

Steps 2, 3 and 5 run as the service user. Steps 1 and 4 need root. The config file holds your secrets. Only the service user can read it.

1. Install the code and the service user.

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin plex-lastfm
   sudo git clone https://github.com/gorfednet/plex-lastfm-sync /opt/plex-lastfm-sync
   sudo install -d -o plex-lastfm -g plex-lastfm -m 700 /etc/plex-lastfm-sync /var/lib/plex-lastfm-sync
   ```

2. Write the config. `init` asks for the Plex token, the Last.fm key and the Last.fm secret at hidden prompts. Nothing is written to shell history. It also finds your Plex server ID and makes the webhook's secret path.

   ```bash
   sudo -u plex-lastfm env PLEX_LASTFM_CONFIG=/etc/plex-lastfm-sync/config.json node /opt/plex-lastfm-sync/bin/plex-lastfm-sync.js init
   ```

3. Link your Last.fm account. The command prints an approval link. Open it, approve, then press Enter.

   ```bash
   sudo -u plex-lastfm env PLEX_LASTFM_CONFIG=/etc/plex-lastfm-sync/config.json node /opt/plex-lastfm-sync/bin/plex-lastfm-sync.js auth
   ```

4. Start the listener.

   ```bash
   sudo cp /opt/plex-lastfm-sync/deploy/plex-lastfm-sync.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now plex-lastfm-sync
   ```

5. Print the webhook address. Add it in Plex under Settings, Webhooks. The address holds a secret. Keep it private.

   ```bash
   sudo -u plex-lastfm env PLEX_LASTFM_CONFIG=/etc/plex-lastfm-sync/config.json node /opt/plex-lastfm-sync/bin/plex-lastfm-sync.js webhook-url
   ```

6. Rate a track 5 stars and check Last.fm. Watch the listener with `journalctl -u plex-lastfm-sync -f`.

## Bulk runs

```bash
plex-lastfm-sync backfill          # love every 5-star Plex track Last.fm lacks
plex-lastfm-sync sync              # backfill, plus 5 stars in Plex for each unrated Last.fm love
```

Run them as in step 2 (`sudo -u plex-lastfm env PLEX_LASTFM_CONFIG=… node …/bin/plex-lastfm-sync.js <command>`).

Every bulk run starts as a dry run. It prints counts and writes a plan report that lists every track it would change. Then it asks before it changes anything. A second report records what was applied.

| Option | Effect |
|---|---|
| `--dry-run` | Counts and report only. Changes nothing. |
| `--yes` | Applies without asking. For cron. |
| `--all-copies` | `sync` only. Rates every unrated copy of a song that appears on several albums. |

A rerun finds nothing left to do. A rating made in Plex after the plan was drawn up is never overwritten.

## How tracks are decided

| Plex rating | Last.fm | Result |
|---|---|---|
| 5 stars | not loved | Loved. |
| 5 stars | loved | Nothing. |
| not rated | loved | `sync` rates it 5 stars. |
| 1 to 4½ stars | loved | Reported as a conflict. The Plex rating stays. |
| lowered from 5 stars | loved | The live listener unloves it, if the tool loved it itself. |

- **Matching** uses artist and title. Case, accents, punctuation and "&" versus "and" are folded. Nothing fuzzier. Last.fm's love list has no album. A song that appears on several albums is ambiguous. The `sync` command reports it and leaves it alone unless you pass `--all-copies`.
- **Compilations.** Matching uses the track artist and ignores "Various Artists". A love for "X" never matches a track by "X & Y".
- **Unmatched.** A Last.fm love that isn't in your Plex library is listed in the report. Nothing is guessed.
- **Unlove.** Only a love the tool made itself is ever unloved. A track you'd already loved on Last.fm stays loved, whatever happens to its rating. A love that led `sync` to rate a track in Plex isn't the tool's either.
- **Gaps.** An event that fails after Last.fm's retries is logged and dropped. A scheduled `backfill --yes` (a daily cron or timer) loves any 5-star track the listener missed. It can't repair a missed unlove.
- **Incomplete reads.** If Plex or Last.fm returns fewer tracks than they report, the run stops with an error. It never works from a partial list.
- **Reports** go to the state directory as text and JSON.

## Load on your machines

- Last.fm calls are capped at 5 a second and retried with backoff on temporary errors.
- Plex is read in pages of 200 tracks with a pause between pages. A bulk run on 100,000 tracks makes about 500 small requests. Each love also checks the track in Plex first. Rating writes pause 250 ms apart, so a `sync` doesn't flood the listener with its own webhooks.
- The listener is idle between ratings. The unit file limits it to 128 MB and 20% of 1 CPU.

## Config

`config.example.json` shows the shape. `init` writes the file for you. The path comes from `PLEX_LASTFM_CONFIG` or `--config`. The tool refuses to start if the file is readable by anyone but its owner.

| Field | Meaning |
|---|---|
| `lastfm.apiKey`, `lastfm.sharedSecret` | From your Last.fm API account. |
| `lastfm.sessionKey`, `lastfm.username` | Written by `auth`. |
| `plex.url`, `plex.token` | Your server and its token. |
| `plex.serverUuid` | Found by `init`. Payloads from any other server are rejected. |
| `plex.accountId` | Optional. Only ratings from this Plex account count. |
| `plex.pageDelayMs`, `plex.rateDelayMs` | Optional. Pauses in milliseconds between library pages (default 100) and between rating writes (default 250). |
| `plex.sectionIds` | Optional. Limits bulk runs to these music libraries. |
| `listener.host`, `listener.port` | A loopback, private or Tailscale address. Never `0.0.0.0`. |
| `listener.pathToken` | The secret part of the webhook address. |
| `stateFile`, `reportDir` | Absolute paths for the tool's record of its own loves and for its reports. |

## Tests

```bash
npm test
```

The suite runs a fake Plex and a fake Last.fm API as real HTTP servers on loopback. It never touches the network. The webhook fixture in `test/fixtures` is written to match Plex's documented `media.rate` payload. A captured payload holds your public IP address, account name, avatar link and server ID. Replace each with a fake value before it goes in the repository. A test fails if an identifying field isn't obviously fake.

## Security

See [SECURITY.md](SECURITY.md). Report problems privately.

## Licence

MIT. See [LICENSE](LICENSE).
