// Local preview for the userscript: no Tampermonkey, no real Mail Hub.
//
//   npm run preview:userscript      → http://signup.example.localhost:8765/
//
// Everything that must survive a page navigation lives here, in memory:
// the GM key/value store, the per-tab store, and a fake Mail Hub API.
// The page side (gm-shim.js) only forwards calls to these endpoints.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT || 8765);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

/** GM_getValue / GM_setValue, shared by every origin like the real manager. */
const gmValues = new Map();
/** GM_getTab / GM_saveTab, keyed by the shim's tab id. */
const gmTabs = new Map();

// ---------------------------------------------------------------- fake API
const api = {
  latency: 350,
  inboxes: new Map(),
  queue: [],
  bodies: new Map(),
  fail: {},
  providers: [
    { name: 'outlook', displayName: 'Outlook', enabled: true, autoDispatch: true, features: { pollInbox: true }, rateStatus: { available: true } },
    { name: 'yyds', displayName: 'YYDS Mail', enabled: true, autoDispatch: true, features: { pollInbox: true }, rateStatus: { available: true } },
    { name: 'mailtm', displayName: 'Mail.tm', enabled: true, autoDispatch: true, features: { pollInbox: true }, rateStatus: { available: false, cooldownReason: '冷却中' } },
    { name: 'guerrillamail', displayName: 'Guerrilla Mail', enabled: false, autoDispatch: true, features: { pollInbox: true }, rateStatus: { available: true } },
    { name: 'imap', displayName: 'IMAP 自有域名', enabled: true, autoDispatch: false, features: { pollInbox: true }, rateStatus: { available: true } },
  ],
};

const SAMPLES = {
  code: () => ({ email: { from: 'Example <noreply@example.com>', subject: 'Your Example verification code' },
    codes: [{ type: 'numeric', value: '482913', confidence: 0.95, context: 'Your code is 482913' }],
    text: 'Hi there,\n\nUse this code to verify your email:\n\n482913\n\nIt expires in 10 minutes.\n\n— The Example team' }),
  multi: () => ({ email: { from: 'Example <noreply@example.com>', subject: '欢迎注册 Example' },
    codes: [
      { type: 'numeric', value: '482913', context: '验证码：482913，10 分钟内有效' },
      { type: 'numeric', value: '2026', context: '© 2026 Example Inc.' },
      { type: 'alphanumeric', value: 'A7K2PQ', context: '订单号 A7K2PQ' },
    ],
    text: '验证码：482913，10 分钟内有效。\n订单号 A7K2PQ\n© 2026 Example Inc.' }),
  link: () => ({ email: { from: 'GitHub <noreply@github.com>', subject: 'Please verify your email address' },
    codes: [{ type: 'link', value: 'https://github.com/users/confirm?token=abcdef1234567890abcdef' }],
    text: 'Almost done! Confirm your address:\n\nhttps://github.com/users/confirm?token=abcdef1234567890abcdef' }),
  both: () => ({ email: { from: 'Example <noreply@example.com>', subject: 'Confirm your Example account' },
    codes: [{ type: 'numeric', value: '771204' }, { type: 'link', value: 'https://example.com/verify?t=xyz' }],
    text: 'Code: 771204\nOr click https://example.com/verify?t=xyz' }),
  long: () => ({ email: { from: 'Spring Prompt <ellis@springprompt.example>', subject: 'Your sign-in code: 98389170' },
    codes: [{ type: 'numeric', value: '98389170' }, { type: 'link', value: 'https://springprompt.example/verify?t=abc' }],
    text: 'Your sign-in code: 98389170\nOr open https://springprompt.example/verify?t=abc' }),
  alnum: () => ({ email: { from: 'Example <noreply@example.com>', subject: 'Your one-time token' },
    codes: [{ type: 'alphanumeric', value: 'K7Q2X9WA3M' }],
    text: 'Token: K7Q2X9WA3M' }),
  none: () => ({ email: { from: 'Example <hello@example.com>', subject: 'Welcome to Example!' }, codes: [],
    text: 'Thanks for joining Example. Nothing to do here.' }),
};

function deliver(kind) {
  const make = SAMPLES[kind] ?? SAMPLES.code;
  const sample = make();
  const id = `msg-${Math.random().toString(36).slice(2, 8)}`;
  const message = { messageId: id, receivedAt: new Date().toISOString(), email: sample.email, codes: sample.codes };
  api.bodies.set(id, { ...message, text: sample.text });
  api.queue.push(message);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleApi(method, path, query, body) {
  await delay(api.latency);
  const failure = (key) => api.fail[key];
  if (path === '/api/providers') return [200, { providers: api.providers }];

  if (path === '/api/inbox' && method === 'POST') {
    if (failure('create')) return failure('create') === 'timeout' ? 'timeout' : [failure('create'), { error: '上游提供商故障' }];
    const id = `ibx_${Math.random().toString(36).slice(2, 10)}`;
    const provider = body?.provider || 'outlook';
    const domain = provider === 'yyds' ? 'yyds.mail' : provider === 'imap' ? 'catch.example.net' : 'outlook.com';
    const address = `kestrel.${Math.random().toString(36).slice(2, 7)}@${domain}`;
    const expires = new Date(Date.now() + 864e5).toISOString();
    api.inboxes.set(id, { id, address, provider, target_service: body?.for ?? null, status: 'active', expires_at: expires });
    return [200, { id, address, provider, expiresAt: expires, features: {} }];
  }

  let match = path.match(/^\/api\/inbox\/([^/]+)$/);
  if (match) {
    const inbox = api.inboxes.get(decodeURIComponent(match[1]));
    if (!inbox) return [404, { error: 'not found' }];
    if (method === 'DELETE') {
      if (failure('close')) return failure('close') === 'timeout' ? 'timeout' : [failure('close'), { error: '关闭失败' }];
      inbox.status = 'closed';
      return [200, { ok: true }];
    }
    return [200, inbox];
  }

  match = path.match(/^\/api\/inbox\/([^/]+)\/code$/);
  if (match) {
    if (!api.inboxes.has(decodeURIComponent(match[1]))) return [404, { error: 'not found' }];
    if (failure('code')) return [failure('code'), { error: '限流' }];
    const waitMs = Math.min(Number(query.get('timeout') || 1), 5) * 1000;
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      if (api.queue.length) return [200, api.queue.shift()];
      await delay(200);
    }
    return [200, { codes: [], email: null, messageId: null, receivedAt: null }];
  }

  match = path.match(/^\/api\/inbox\/([^/]+)\/messages\/([^/]+)$/);
  if (match) {
    const stored = api.bodies.get(decodeURIComponent(match[2]));
    if (!stored) return [404, { error: 'not found' }];
    return [200, { id: stored.messageId, from: stored.email.from, subject: stored.email.subject, excerpt: '', receivedAt: stored.receivedAt, text: stored.text, html: null }];
  }

  match = path.match(/^\/api\/inbox\/([^/]+)\/report$/);
  if (match) {
    if (failure('report')) return failure('report') === 'timeout' ? 'timeout' : [failure('report'), { error: '上报失败' }];
    return [200, { ok: true, action: 'recorded' }];
  }

  if (path === '/api/inboxes') return [200, { inboxes: [...api.inboxes.values()].filter((row) => row.status === 'active') }];
  return [404, { error: `no route ${path}` }];
}

// ---------------------------------------------------------------- server
function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (path === '/__gm/get') return send(res, 200, { value: gmValues.has(url.searchParams.get('k')) ? gmValues.get(url.searchParams.get('k')) : null, has: gmValues.has(url.searchParams.get('k')) });
    if (path === '/__gm/set') { const body = await readBody(req); gmValues.set(body.k, body.v); return send(res, 200, { ok: true }); }
    if (path === '/__gm/del') { const body = await readBody(req); gmValues.delete(body.k); return send(res, 200, { ok: true }); }
    if (path === '/__gm/tab/get') return send(res, 200, { value: gmTabs.get(url.searchParams.get('id')) ?? null });
    if (path === '/__gm/tab/set') { const body = await readBody(req); gmTabs.set(body.id, body.v); return send(res, 200, { ok: true }); }
    if (path === '/__gm/reset') { gmValues.clear(); gmTabs.clear(); api.inboxes.clear(); api.queue.length = 0; api.fail = {}; return send(res, 200, { ok: true }); }

    if (path === '/__ctl/deliver') { deliver(url.searchParams.get('kind') || 'code'); return send(res, 200, { ok: true, queued: api.queue.length }); }
    if (path === '/__ctl/fail') {
      const key = url.searchParams.get('op');
      const value = url.searchParams.get('value');
      if (!value) delete api.fail[key]; else api.fail[key] = /^\d+$/.test(value) ? Number(value) : value;
      return send(res, 200, { fail: api.fail });
    }
    if (path === '/__ctl/latency') { api.latency = Number(url.searchParams.get('ms') || 350); return send(res, 200, { latency: api.latency }); }
    if (path === '/__ctl/state') return send(res, 200, { fail: api.fail, latency: api.latency, queued: api.queue.length, inboxes: [...api.inboxes.values()] });

    if (path.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const result = await handleApi(req.method, path, url.searchParams, body);
      if (result === 'timeout') return; // never answer: the client's own deadline fires
      return send(res, result[0], result[1]);
    }

    const file = path === '/' ? 'dev/preview.html' : normalize(path).replace(/^[/\\]+/, '');
    if (file.includes('..')) return send(res, 400, 'bad path', 'text/plain');
    const data = await readFile(join(root, file));
    return send(res, 200, data.toString('utf8'), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch (error) {
    if (error && error.code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    return send(res, 500, String(error), 'text/plain');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`userscript preview: http://signup.example.localhost:${PORT}/`);
});
