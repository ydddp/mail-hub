import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { setSetting } from '../src/db.js';
import { fetchWithTimeout } from '../src/utils.js';
import { withReadBudget } from '../src/read-budget.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();
async function listen(server: Server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

// Actual sockets/undici prove both cancellation and attribution; mocks cannot
// establish whether a CONNECT verdict or response body is really observable.
it.each(['response_headers', 'body', 'proxy502', 'proxy504', 'tls'])('attributes a real %s failure without exposing request/response secrets', async phase => {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const requestId = '12345678-1234-1234-1234-123456789abc';
  let activeSocket: Socket | undefined;
  const server = createServer((_req, res) => {
    activeSocket = _req.socket;
    if (phase === 'body') {
      res.writeHead(200, { 'request-id': requestId, 'Content-Length': '1000' });
      res.write('private-mail-body');
    }
  });
  server.on('connect', (_req, socket) => {
    const status = phase === 'tls' ? 200 : phase === 'proxy502' ? 502 : 504;
    socket.write(`HTTP/1.1 ${status} Test\r\nContent-Length: 0\r\n\r\n`);
    if (status !== 200) socket.end();
  });
  const address = await listen(server);
  const proxied = phase.startsWith('proxy') || phase === 'tls';
  setSetting('proxy_url', proxied ? address.replace('http://', 'http://private-user:private-password@') : '');
  const target = proxied ? 'https://mail.invalid/private-link?token=private-token' : `${address}/private-link?token=private-token`;
  await expect(withReadBudget({ deadline: Date.now() + 300, requestId }, async () => {
    const response = await fetchWithTimeout(target, { diagnostic: 'inbox', retries: 0, headers: { Authorization: 'Bearer private-token' } });
    await response.text();
  })).rejects.toThrow();
  const entries = output.flatMap(line => line.trim() ? [JSON.parse(line)] : []);
  const record = entries.find(entry => entry.msg === 'upstream attempt');
  expect(record).toMatchObject({ requestId, operation: 'inbox', attempt: 1, phase: phase.startsWith('proxy') ? 'proxy_connect' : phase });
  if (phase.startsWith('proxy')) expect(record.connectStatus).toBe(phase === 'proxy502' ? 502 : 504);
  if (phase === 'body') expect(record).toMatchObject({ upstreamRequestId: requestId, status: 200 });
  if (!proxied) await expect.poll(() => activeSocket?.destroyed, { timeout: 1000 }).toBe(true);
  expect(output.join('')).not.toMatch(/private-|mail\.invalid/);
});
