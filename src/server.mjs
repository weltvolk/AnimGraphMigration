import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { COMMAND_SCHEMAS, runCommand } from './commands.mjs';

export async function startServer({ port = '0', quiet = false, open = false } = {}) {
  const parsedPort = Number(port);
  if (!/^\d+$/u.test(String(port)) || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) throw new Error('Port must be between 0 and 65535');
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(`Bearer ${token}`);
  const html = await fs.readFile(new URL('../web/index.html', import.meta.url));
  const logo = await fs.readFile(new URL('../assets/logo.svg', import.meta.url));
  let origin;
  let running = false;
  const server = http.createServer(async (request, response) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer',
      });
      response.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    if (request.headers.host !== new URL(origin).host) return send(403, { error: 'Unexpected Host' });
    if (request.method === 'GET' && request.url === '/') return send(200, html, 'text/html; charset=utf-8');
    if (request.method === 'GET' && request.url === '/assets/logo.svg') return send(200, logo, 'image/svg+xml');
    if (request.method !== 'POST' || !Object.keys(COMMAND_SCHEMAS).some(command => request.url === `/api/${command}`)) return send(404, { error: 'Not found' });
    const credentials = Buffer.from(request.headers.authorization ?? '');
    if (credentials.length !== tokenBytes.length || !timingSafeEqual(credentials, tokenBytes)) return send(403, { error: 'Missing or invalid local session token' });
    if (request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'Unexpected Origin' });
    if (request.headers['content-type'] !== 'application/json') return send(415, { error: 'Expected application/json' });
    if (running) return send(409, { error: 'A migration is already running' });
    running = true;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) { send(413, { error: 'Request too large' }); request.destroy(); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const command = request.url.split('/').at(-1);
      const result = await runCommand(command, input);
      send(200, result);
    } catch (error) {
      send(422, { error: error.message });
    } finally { running = false; }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(parsedPort, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  if (!quiet) console.log(`AnimGraphMigration – lokale Oberfläche\n${url}\nZum Beenden Strg+C. Es werden keine Moddateien ins Internet übertragen.`);
  if (open) {
    const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const browser = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.error('Browser konnte nicht geöffnet werden. Bitte die angezeigte lokale Adresse öffnen.'));
    browser.unref();
  }
  return { server, origin, token, url };
}
