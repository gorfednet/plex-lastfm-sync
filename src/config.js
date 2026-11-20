import { readFileSync, statSync, writeSync, renameSync, openSync, closeSync, mkdirSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { registerSecret } from './logger.js';

export const CONFIG_ENV = 'PLEX_LASTFM_CONFIG';

export class ConfigError extends Error {}

// Local or Tailscale addresses only. Never a wildcard, never a public address.
export function isPrivateBindAddress(host) {
  if (host === 'localhost') return true;
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    const h = host.toLowerCase();
    return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  return false;
}

export function resolveConfigPath(argPath, env = process.env) {
  const p = argPath || env[CONFIG_ENV];
  if (!p) throw new ConfigError(`Set ${CONFIG_ENV} to the path of the config file (or pass --config).`);
  return p;
}

function checkFileMode(path) {
  const st = statSync(path);
  if (!st.isFile()) throw new ConfigError(`${path} is not a regular file.`);
  if ((st.mode & 0o077) !== 0) {
    throw new ConfigError(`${path} must be mode 600 (owner only). Run: chmod 600 ${path}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new ConfigError(`${path} must be owned by the user running this tool.`);
  }
}

function apiUrlOk(v) {
  let u;
  try { u = new URL(v); } catch { return false; }
  if (u.username || u.password) return false;
  return (u.protocol === 'https:' && u.hostname === 'ws.audioscrobbler.com') || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
}

function need(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

export function validate(raw, { requireSession = false, requireListener = false } = {}) {
  need(raw && typeof raw === 'object', 'Config must be a JSON object.');
  const lf = raw.lastfm ?? {};
  const px = raw.plex ?? {};
  const ls = raw.listener ?? {};
  need(typeof lf.apiKey === 'string' && lf.apiKey, 'lastfm.apiKey is missing.');
  need(typeof lf.sharedSecret === 'string' && lf.sharedSecret, 'lastfm.sharedSecret is missing.');
  need(typeof px.url === 'string' && /^https?:\/\//.test(px.url), 'plex.url must start with http:// or https://.');
  need(typeof px.token === 'string' && px.token, 'plex.token is missing.');
  need(typeof px.serverUuid === 'string' && px.serverUuid, 'plex.serverUuid is missing (run init).');
  if (requireSession) need(lf.sessionKey && lf.username, 'No Last.fm session yet. Run the auth command first.');
  if (requireListener || raw.listener) {
    need(typeof ls.host === 'string' && isPrivateBindAddress(ls.host),
      'listener.host must be a loopback, private or Tailscale address (never 0.0.0.0 or a public one).');
    need(Number.isInteger(ls.port) && ls.port > 0 && ls.port < 65536, 'listener.port must be 1-65535.');
    need(typeof ls.pathToken === 'string' && TOKEN_RE.test(ls.pathToken), 'listener.pathToken must be 32 or more characters from A-Z a-z 0-9 _ -.');
  }
  if (lf.apiUrl !== undefined) need(apiUrlOk(lf.apiUrl), 'lastfm.apiUrl may only be the Last.fm API or a loopback address (for tests).');
  if (px.sectionIds !== undefined) need(Array.isArray(px.sectionIds) && px.sectionIds.every((s) => typeof s === 'string'), 'plex.sectionIds must be an array of strings.');
  need(typeof raw.stateFile === 'string' && isAbsolute(raw.stateFile), 'stateFile must be an absolute path.');
  need(typeof raw.reportDir === 'string' && isAbsolute(raw.reportDir), 'reportDir must be an absolute path.');
  const cfg = {
    lastfm: { apiKey: lf.apiKey, sharedSecret: lf.sharedSecret, sessionKey: lf.sessionKey ?? '', username: lf.username ?? '', apiUrl: lf.apiUrl },
    plex: {
      url: px.url.replace(/\/+$/, ''), token: px.token, serverUuid: px.serverUuid,
      accountId: px.accountId === undefined ? undefined : String(px.accountId),
      sectionIds: px.sectionIds, pageDelayMs: Number.isFinite(px.pageDelayMs) ? px.pageDelayMs : 100,
      rateDelayMs: Number.isFinite(px.rateDelayMs) ? px.rateDelayMs : 250,
    },
    listener: raw.listener ? { host: ls.host, port: ls.port, pathToken: ls.pathToken } : undefined,
    stateFile: raw.stateFile,
    reportDir: raw.reportDir,
  };
  for (const s of [cfg.lastfm.apiKey, cfg.lastfm.sharedSecret, cfg.lastfm.sessionKey, cfg.plex.token, cfg.listener?.pathToken]) registerSecret(s);
  return cfg;
}

export function loadConfig(path, opts) {
  let text;
  try {
    checkFileMode(path);
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Cannot read config ${path}: ${e.code ?? 'error'}`);
  }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new ConfigError(`${path} is not valid JSON.`); }
  return { path, raw, config: validate(raw, opts) };
}

// Writes the file with mode 600 from the first byte, through the open descriptor, flushes it, then renames it
// into place. A failed write removes its temp file.
export function writeConfig(path, raw) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(raw, null, 2) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export function newPathToken() {
  return randomBytes(32).toString('base64url');
}
