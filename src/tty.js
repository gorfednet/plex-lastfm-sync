import { createInterface } from 'node:readline';

export function askVisible(question, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question + (fallback ? ` [${fallback}] ` : ' '), (a) => { rl.close(); resolve(a.trim() || fallback); }));
}

// Reads a line from the terminal without echoing it. Refuses to run without a TTY, so a secret can never
// arrive through a command-line argument, an environment variable or a pipe.
export function askHidden(question) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('This prompt needs an interactive terminal.'));
  return new Promise((resolve, reject) => {
    process.stderr.write(question + ' ');
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    let escape = 0; // swallow arrow-key and other escape sequences instead of typing them into the secret
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape === 1) { escape = ch === '[' || ch === 'O' ? 2 : 0; continue; } // the byte after ESC
        if (escape === 2) { if (/[A-Za-z~]/.test(ch)) escape = 0; continue; }
        if (ch === '\u001b') { escape = 1; continue; }
        if (ch === '\r' || ch === '\n') { done(); return resolve(value.trim()); }
        if (ch === '\u0003') { done(); return reject(new Error('Cancelled.')); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
