// A logger that scrubs known secrets from every line it writes.
// Secrets are registered once at start-up; any later line containing one has it replaced.
const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

export function scrub(text) {
  let out = String(text);
  for (const s of secrets) {
    out = out.split(s).join('[redacted]');
    out = out.split(encodeURIComponent(s)).join('[redacted]');
  }
  return out;
}

function line(level, msg, fields) {
  const extra = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : '';
  return scrub(`${new Date().toISOString()} ${level} ${msg}${extra}`);
}

export const log = {
  out: (s) => process.stdout.write(scrub(s) + '\n'),
  info: (msg, fields) => process.stderr.write(line('info', msg, fields) + '\n'),
  warn: (msg, fields) => process.stderr.write(line('warn', msg, fields) + '\n'),
  error: (msg, fields) => process.stderr.write(line('error', msg, fields) + '\n'),
};
