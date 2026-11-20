# Pull request review (plex-lastfm-sync)

Read by the Claude reviewer (`.github/workflows/claude-review.yml`, which calls the shared workflow in `gorfednet/.github`) on every non-draft pull request and on a `claude review` comment. The shared workflow says what to report in general. This file holds what is particular to this repository.

## What this repository is

Keeps Plex 5-star ratings and Last.fm loves in step, in both directions. Public, self-hosted Node.js service with no dependencies.

## House rules to hold the change to

- A change that fixes a bug comes with a test that fails without it.
- A check is never made green by weakening it: no lowered floor, widened tolerance or deleted assertion.
- The service has no npm dependencies. A change that adds one needs a reason in the pull request.
- Secrets (the Plex token, the Last.fm key and secret, the webhook path) never reach a log line, an error message, a test fixture or a commit. Read every changed log and error string for them.
- Plex wins every disagreement in the full sync. A change to that direction is High until a test shows both directions.
- Open work lives in `docs/backlog.json` as typed entries, with `created` and `updated` dates.
- The 4th review round is a pull request's last for Low findings. From round 5, reply to each Low with fix, defer or decline; only High or Medium forces a fix.
- No secrets in the repository: `.deploy-env`, keys and tokens stay out.

## Where the rules live

- `CLAUDE.md`, `docs/backlog.json`, `docs/verification-rules.md`
