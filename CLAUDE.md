# plex-lastfm-sync

Keeps Plex 5-star ratings and Last.fm loves in step, in both directions. Public, self-hosted Node.js service with no dependencies.

## Plan of record
- Open work for this repository: `docs/backlog.json` (typed entries).
- The fleet's plan of record (`control/plan-of-record.md`) is kept privately. This repository is registered in `gorfednet/.github`, in `fleet.json` and in ship-bot's `config.example.json`.
- Every change is a branch and a pull request. Ship-bot merges a pull request labelled `ready-to-merge` once its checks and the Claude review are clean.

## Handoffs and status
- Context that must outlive a session lives in `docs/handoff/<date>-<topic>.md`. The `/handoff` skill writes one from `templates/handoff.md` in `gorfednet/.github`.
- Every open pull request carries a `## Next` section in its body with `- [ ]` lines. Any turn that leaves the PR open rewrites it.
- Backlog entries in `docs/backlog.json` carry `created` and `updated` dates (YYYY-MM-DD).
- Open PRs, lapsed backlog items and red mains are in `STATUS.md` on the `status` branch of `gorfednet/.github`. Read it before coordinating and report from it.
