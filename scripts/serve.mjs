import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, 'dist');
const version = JSON.parse(readFileSync(resolve(project, 'VERSION.json'), 'utf8')).version;
const port = Number(process.env.ROADSTER_PORT || 5189);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ROADSTER_PORT must be between 1024 and 65535.');
if (!existsSync(resolve(root, 'index.html'))) {
  console.error('Game build missing. Run npm install and npm run build first.');
  process.exit(1);
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const url = `http://127.0.0.1:${port}/`;
function openBrowser() {
  if (!process.argv.includes('--open') || process.env.ROADSTER_NO_OPEN === '1') return;
  const command = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open this address in your browser: ${url}`));
  child.unref();
}
const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, url).pathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  if (pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ product: 'Roadster Flight Lab', version, root }));
    return;
  }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${sep}`) || pathname.includes('\0')) { response.writeHead(403); response.end('Forbidden'); return; }
  let size;
  try { const stats = statSync(file); if (!stats.isFile()) throw new Error(); size = stats.size; }
  catch { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
});
server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`${url}health`, { signal: AbortSignal.timeout(1500) });
      const current = await response.json();
      if (current.product === 'Roadster Flight Lab' && current.version === version && current.root === root) {
        console.log(`Roadster Flight Lab ${version} is already running: ${url}`);
        openBrowser(); return;
      }
    } catch { /* An occupied port is never assumed to be this game. */ }
    console.error(`Port ${port} is occupied by another service. Set ROADSTER_PORT to another port.`);
  } else console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`\nRoadster Flight Lab ${version}\n${url}\nKeep this window open while playing. Ctrl+C stops the game server.\n`);
  openBrowser();
});
