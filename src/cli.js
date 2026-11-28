import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, writeConfig, resolveConfigPath, newPathToken, ConfigError, validate, CONFIG_ENV } from './config.js';
import { log, registerSecret } from './logger.js';
import { createLastfm } from './lastfm.js';
import { createPlex } from './plex.js';
import { createFileStore } from './state.js';
import { createListener } from './listener.js';
import { runBulk } from './bulk.js';
import { askHidden, askVisible } from './tty.js';

const HELP = `plex-lastfm-sync <command> [--config <file>]

Commands:
  init          Ask for the Last.fm key and secret and the Plex token (hidden prompts) and write the config file.
  auth          Link a Last.fm account: prints an approval URL, then stores the session key.
  webhook-url   Print the URL to paste into Plex under Settings > Webhooks.
  serve         Run the webhook listener.
  backfill      Love on Last.fm every track rated 5 stars in Plex.
  sync          Full sync: backfill, plus 5 stars in Plex for each Last.fm love Plex leaves unrated.

Bulk options:  --dry-run (counts and report only)   --yes (apply without asking)   --all-copies (sync only)
The config path comes from ${CONFIG_ENV} or --config.`;

async function init(configPath) {
  if (existsSync(configPath)) throw new ConfigError(`${configPath} already exists. Edit it, or move it aside to start again.`);
  const plexUrl = (await askVisible('Plex address', 'http://127.0.0.1:32400')).replace(/\/+$/, '');
  const plexToken = await askHidden('Plex token (hidden):');
  const apiKey = await askHidden('Last.fm API key (hidden):');
  const sharedSecret = await askHidden('Last.fm shared secret (hidden):');
  for (const s of [plexToken, apiKey, sharedSecret]) registerSecret(s);
  const plex = createPlex({ url: plexUrl, token: plexToken });
  const serverUuid = await plex.identity();
  const sections = await plex.musicSections(); // proves the token works
  if (!serverUuid) throw new ConfigError('Plex did not report a server identity.');
  const port = Number(await askVisible('Listener port', '18094'));
  const host = await askVisible('Listener address (loopback, private or Tailscale)', '127.0.0.1');
  const stateDir = await askVisible('State directory', '/var/lib/plex-lastfm-sync');
  const raw = {
    lastfm: { apiKey, sharedSecret },
    plex: { url: plexUrl, token: plexToken, serverUuid },
    listener: { host, port, pathToken: newPathToken() },
    stateFile: join(stateDir, 'state.json'),
    reportDir: join(stateDir, 'reports'),
  };
  validate(raw);
  writeConfig(configPath, raw);
  log.out(`Config written to ${configPath} (mode 600). Plex music libraries found: ${sections.map((s) => s.title).join(', ') || 'none'}.`);
  log.out('Next: run the auth command.');
}

async function auth(configPath) {
  const { raw, config } = loadConfig(configPath);
  const { lastfm } = clients(config);
  const token = await lastfm.getToken();
  // The API key in this URL is not secret (Last.fm shows it in every approval link), so it is printed unscrubbed.
  process.stdout.write(`Open this URL in a browser, sign in to Last.fm and approve the application:\n\n  ${lastfm.authUrl(token)}\n\n`);
  await askVisible('Press Enter once you have approved it.');
  const session = await lastfm.getSession(token);
  raw.lastfm.sessionKey = session.key;
  raw.lastfm.username = session.name;
  writeConfig(configPath, raw);
  log.out(`Linked to Last.fm user ${session.name}. The session key is stored in the config file.`);
}

function clients(config) {
  return {
    plex: createPlex({ url: config.plex.url, token: config.plex.token, pageDelayMs: config.plex.pageDelayMs }),
    lastfm: createLastfm({ apiKey: config.lastfm.apiKey, sharedSecret: config.lastfm.sharedSecret, sessionKey: config.lastfm.sessionKey, username: config.lastfm.username, ...(config.lastfm.apiUrl ? { baseUrl: config.lastfm.apiUrl } : {}) }),
  };
}

// The session key must belong to the configured Last.fm account, or "is it loved?" would ask about the wrong one.
async function verifyAccount(lastfm, config) {
  const name = await lastfm.sessionUser();
  if (typeof name !== 'string' || name.toLowerCase() !== config.lastfm.username.toLowerCase()) {
    throw new ConfigError('The Last.fm session does not belong to the configured username. Run the auth command again.');
  }
}

let serving = false;

async function serve(configPath) {
  const { config } = loadConfig(configPath, { requireSession: true, requireListener: true });
  const { plex, lastfm } = clients(config);
  await verifyAccount(lastfm, config);
  const store = createFileStore(config.stateFile);
  try { store.check(); } catch (e) { throw new ConfigError(e.message); } // refuses to start on a damaged state file
  const { server, idle } = createListener({ config, plex, lastfm, store, log });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listener.port, config.listener.host, resolve); });
  serving = true;
  log.info('listening', { host: config.listener.host, port: config.listener.port });
  // On a stop, finish the events already accepted before exiting.
  const stop = () => server.close(async () => { await idle(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function bulk(name, configPath, values) {
  const { config } = loadConfig(configPath, { requireSession: true });
  const { plex, lastfm } = clients(config);
  await verifyAccount(lastfm, config);
  const store = createFileStore(config.stateFile);
  try { store.check(); } catch (e) { throw new ConfigError(e.message); }
  const confirm = async () => {
    if (values.yes) return true;
    if (!process.stdin.isTTY) { log.out('Not applying: run with --yes to apply without a prompt.'); return false; }
    return /^y(es)?$/i.test(await askVisible('Apply these changes? (y/N)'));
  };
  await runBulk({ name, rate: name === 'sync', allCopies: Boolean(values['all-copies']), dryRun: Boolean(values['dry-run']), confirm, plex, lastfm, config, store, log });
}

export async function main(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, 'all-copies': { type: 'boolean' }, help: { type: 'boolean' } },
    }));
  } catch (e) {
    log.error(e.message);
    return { code: 1, serving: false };
  }
  const [cmd] = positionals;
  if (!cmd || values.help) { log.out(HELP); return { code: values.help ? 0 : 1, serving: false }; }
  try {
    const configPath = resolveConfigPath(values.config);
    if (cmd === 'init') await init(configPath);
    else if (cmd === 'auth') await auth(configPath);
    else if (cmd === 'webhook-url') {
      const { config } = loadConfig(configPath, { requireListener: true });
      // Deliberately unscrubbed: the owner needs the path token to paste into Plex.
      const host = config.listener.host.includes(':') ? `[${config.listener.host}]` : config.listener.host;
      process.stdout.write(`http://${host}:${config.listener.port}/hook/${config.listener.pathToken}\n`);
    } else if (cmd === 'serve') await serve(configPath);
    else if (cmd === 'backfill' || cmd === 'sync') await bulk(cmd, configPath, values);
    else { log.out(HELP); return { code: 1, serving: false }; }
    return { code: 0, serving };
  } catch (e) {
    log.error(e.message);
    // 78 is a configuration error: the unit does not restart on it.
    return { code: e instanceof ConfigError ? 78 : 1, serving: false };
  }
}
