# Security

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository (Security tab, Report a vulnerability). Please don't open a public issue for a security problem.

## What the tool holds

| Secret | Where it's stored |
|---|---|
| Last.fm API key and shared secret | The config file |
| Last.fm session key | The config file, written by `auth` |
| Plex token | The config file |
| Webhook path token | The config file |

- The config file is mode 600, owned by the service user. The tool refuses to start otherwise.
- `init` reads secrets only from hidden terminal prompts. They never pass through arguments, environment variables or pipes.
- Every log line is scrubbed against the configured values. The tool prints a credential in 2 places only, both on purpose. The `webhook-url` command prints the webhook address because you must paste it into Plex. The `auth` command prints Last.fm's approval link, which includes the API key by design. The shared secret and session key are never printed.
- The repository holds no credential. A test scans every file for credential-shaped strings. Fixtures use obviously fake values.
- The Plex token is sent in a request header. It never appears in a URL.

## The listener

- It binds to a loopback, private or Tailscale address. A wildcard or public address is refused at start-up.
- The webhook address includes a random token of 32 or more characters. A wrong path, token or method all answer the same 404.
- Payloads from a Plex server other than the configured one are rejected.
- The rating is read back from Plex. A forged body claiming 5 stars does nothing if Plex disagrees.
- Bodies over 2 MB are refused. Part headers over 1 KB are refused before they're parsed. Connections, request time and the event queue are capped. Repeats of a pending track collapse into 1 queue entry.
- The unit file runs it as its own user, with no capabilities, a read-only system and 1 writable directory.

## Limits to know about

- Anyone who holds the webhook address can submit events. Each event makes the tool re-read 1 track's rating from Plex. A new 5-star track costs up to 2 Last.fm calls. The queue holds 1,000 pending tracks. A flood past that drops events, real ones included, until it drains. Plex stores the address with your account and sends it in plain HTTP. Treat it like a password.
- The webhook is plain HTTP. Keep it on loopback, or on a Tailscale or private network you trust.
- The tool can love and unlove tracks and set 5-star ratings. It never deletes a track or any library data.
- Anyone with the config file can act as your Last.fm account and read your Plex server. Treat it like a password file.

## Dependencies

None at runtime. The tool uses only Node's standard library. CI actions are pinned to commit SHAs.
