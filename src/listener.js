import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { boundaryOf, payloadFromMultipart } from './multipart.js';
import { applyRating } from './live.js';

const MAX_BODY = 2 * 1024 * 1024; // Plex may attach a thumbnail
const MAX_QUEUE = 1000; // rating keys only, so this is a few kilobytes at most

function sameToken(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createListener({ config, plex, lastfm, store, log }) {
  const hookPath = `/hook/${config.listener.pathToken}`;
  let queue = Promise.resolve();
  const pending = new Set(); // rating keys waiting their turn; a repeat of one adds nothing

  function enqueue(key) {
    if (pending.has(key)) return;
    if (pending.size >= MAX_QUEUE) { log.warn('queue full; event dropped'); return; }
    pending.add(key);
    queue = queue.then(() => { pending.delete(key); return handle(key); }).catch((e) => log.error('webhook job failed', { error: e.message }));
  }

  async function handle(key) {
    const track = await plex.track(key);
    if (!track) { log.info('rated item is not a track; ignored', { ratingKey: key }); return; }
    const result = await applyRating({ track, lastfm, store });
    log.info('rating handled', { ratingKey: key, artist: track.artist, title: track.title, rating: track.rating, action: result.action });
  }

  const server = createServer((req, res) => {
    respond(req, res).catch((e) => {
      log.error('request failed', { error: e.message });
      if (!res.headersSent) { res.statusCode = e.status ?? 400; res.end(); } else res.destroy();
    });
  });

  async function respond(req, res) {
    const end = (code, text = '') => { res.statusCode = code; res.setHeader('content-type', 'text/plain'); res.end(text); };
    // A wrong method, path or token all look the same from outside.
    const urlPath = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || !urlPath.startsWith('/hook/') || !sameToken(urlPath, hookPath)) return end(404);

    let body;
    try { body = await readBody(req); } catch (e) { return end(e.status ?? 400); }

    let payload;
    try {
      const type = req.headers['content-type'] ?? '';
      let text;
      if (/multipart\/form-data/i.test(type)) {
        const boundary = boundaryOf(type);
        text = boundary ? payloadFromMultipart(body, boundary) : null;
      } else if (/application\/json/i.test(type)) {
        text = body.toString('utf8');
      }
      payload = text ? JSON.parse(text) : null;
    } catch { payload = null; }
    if (!payload || typeof payload !== 'object') return end(400);

    const scalar = (v) => typeof v === 'string' || typeof v === 'number';
    if (typeof payload.Server?.uuid !== 'string' || payload.Server.uuid !== config.plex.serverUuid) { log.warn('rejected: wrong Plex server'); return end(403); }
    if (payload.event !== 'media.rate') return end(200, 'ignored');
    if (payload.Metadata?.type !== 'track' || !scalar(payload.Metadata?.ratingKey) || !/^\d+$/.test(String(payload.Metadata.ratingKey))) return end(200, 'ignored');
    if (config.plex.accountId !== undefined && !(scalar(payload.Account?.id) && String(payload.Account.id) === config.plex.accountId)) return end(200, 'ignored');

    end(200, 'ok');
    enqueue(String(payload.Metadata.ratingKey));
  }

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 10;
  return { server, idle: () => queue };
}
