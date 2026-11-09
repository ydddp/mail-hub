import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { describe, expect, it } from 'vitest';

function session() {
  const source = readFileSync(resolve('src/public/js/core/code-session.js'), 'utf8').replace(/^export .*;\r?$/gm, '');
  return runInNewContext(source + '\ncreateCodeSession();');
}

describe('code retrieval page session', () => {
  it('keeps returned message IDs independent per inbox and per page instance', () => {
    const state = session(); const otherWindow = session();
    expect(state.remember(state.capture('a'), 'A')).toBe(true);
    expect(state.remember(state.capture('a'), 'A')).toBe(true);
    state.remember(state.capture('b'), 'B');
    expect([...state.ids('a')]).toEqual(['A']);
    expect([...state.ids('b')]).toEqual(['B']);
    expect([...otherWindow.ids('a')]).toEqual([]);
  });

  it('requires an explicit reset at 20 instead of evicting earlier IDs', () => {
    const state = session(); const ticket = state.capture('a');
    for (let n = 0; n < 20; n++) expect(state.remember(ticket, String(n))).toBe(true);
    expect(state.remember(ticket, 'overflow')).toBe(false);
    expect([...state.ids('a')]).toEqual(Array.from({ length: 20 }, (_, n) => String(n)));
    state.reset('a');
    expect(state.current(ticket)).toBe(false);
    expect(state.remember(state.capture('a'), 'new')).toBe(true);
    expect([...state.ids('a')]).toEqual(['new']);
  });

  it.each(['logout', 'identity change'])('rejects late results after %s and retains no old IDs', () => {
    const state = session(); const ticket = state.capture('a');
    state.remember(ticket, 'old');
    state.clear();
    expect(state.current(ticket)).toBe(false);
    expect(state.remember(ticket, 'late')).toBe(false);
    expect([...state.ids('a')]).toEqual([]);
  });

  it.each([{ ids: ['a'] }, { ids: ['a', 'b'] }])('invalidates in-flight results for closed inboxes $ids only', ({ ids }) => {
    const state = session(); const tickets = ['a', 'b', 'c'].map(id => state.capture(id));
    tickets.forEach(ticket => state.remember(ticket, ticket.inboxId));
    ids.forEach(id => state.reset(id));
    tickets.forEach(ticket => {
      expect(state.current(ticket)).toBe(!ids.includes(ticket.inboxId));
      expect([...state.ids(ticket.inboxId)]).toEqual(ids.includes(ticket.inboxId) ? [] : [ticket.inboxId]);
    });
  });
});

// Execute the real handler with a minimal view surface: request semantics and
// delayed identity changes are user-visible contracts, independent of markup.
function retrieval(api: (path: string) => Promise<unknown>) {
  const strip = (source: string) => source.replace(/^import .*;\r?\n/gm, '').replace(/^export .*;\r?$/gm, '');
  const state = strip(readFileSync(resolve('src/public/js/core/code-session.js'), 'utf8'));
  const source = strip(readFileSync(resolve('src/public/js/views/inboxes.js'), 'utf8'));
  const area = { innerHTML: '', querySelector: () => null };
  const context = { api, document: { getElementById: () => area }, t: (key: string) => key,
    on: () => '', esc: String, EL: {}, mailTime: () => ({ text: '', title: '' }),
    addActivity: () => {}, inboxStatusBadge: () => '', iconBtn: () => '', syncScopeIndicator: () => {}, compareMailReceived: () => 0, console };
  const result = runInNewContext(state + '\n' + source + `
    enterInboxDetail = async () => {}; fadeOutDetail = async () => {};
    deferredLoading = () => () => {}; mailTimeLabel = () => '';
    _allInboxes = [{id:'a',provider:'outlook',address:'a@example.test'}, {id:'b',provider:'outlook',address:'b@example.test'}];
    ({ getCode, viewInbox, clearCodeSession, codeSession, area: document.getElementById('area') });`, context);
  return result;
}

describe('code retrieval actions', () => {
  it.each(['success', 'failure'])('ignores an old inbox list %s after a new code has been displayed', async outcome => {
    let finish: () => void = () => {};
    const ui = retrieval(async path => path.endsWith('/messages')
      ? new Promise((resolve, reject) => { finish = () => outcome === 'success'
        ? resolve({ messages: [], address: 'old-a@example.test' }) : reject(new Error('old list failed')); })
      : { messageId: 'code-B', codes: [{ type: 'numeric', value: '123456', confidence: 1, context: '' }] });
    const pending = ui.viewInbox('a');
    await new Promise(resolve => setTimeout(resolve, 0));
    await ui.getCode('b');
    const displayed = ui.area.innerHTML;
    expect(displayed).toContain('123456');
    finish(); await pending;
    expect(ui.area.innerHTML).toBe(displayed);
    expect([...ui.codeSession.ids('b')]).toEqual(['code-B']);
  });

  it('continues with returned IDs while leaving the current code available to copy', async () => {
    const requests: string[] = [];
    let release: (value: unknown) => void = () => {};
    const ui = retrieval(async path => {
      requests.push(path);
      if (requests.length === 1) return { messageId: 'A', codes: [{type:'numeric',value:'123456',confidence:1,context:''}] };
      return new Promise(resolve => { release = resolve; });
    });
    await ui.getCode('a');
    const next = ui.getCode('a', true, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests[1]).toContain('excludeMessageId=A');
    expect(requests[1]).toContain('wait=true');
    expect(ui.area.innerHTML).toContain('123456');
    release({ codes: [], scan: { reason: 'timeout' } });
    await next;
    expect(ui.area.innerHTML).toContain('123456');
    expect([...ui.codeSession.ids('a')]).toEqual(['A']);
  });

  it('does not render or remember a late code after logout or identity change', async () => {
    let release: (value: unknown) => void = () => {};
    const ui = retrieval(() => new Promise(resolve => { release = resolve; }));
    const pending = ui.getCode('a');
    await new Promise(resolve => setTimeout(resolve, 0));
    ui.clearCodeSession();
    release({ messageId:'late', codes:[{type:'numeric',value:'654321',confidence:1,context:''}] });
    await pending;
    expect(ui.area.innerHTML).toBe('');
    expect([...ui.codeSession.ids('a')]).toEqual([]);
  });

  it('loads fresh inbox metadata after an identity change', async () => {
    const requests: string[] = [];
    const ui = retrieval(async path => {
      requests.push(path);
      return path === '/inbox/a' ? { provider:'outlook', address:'new-owner@example.test' }
        : { messageId:'new', codes:[{type:'numeric',value:'123456',confidence:1,context:''}] };
    });
    ui.clearCodeSession();
    await ui.getCode('a');
    expect(requests[0]).toBe('/inbox/a');
    expect(ui.area.innerHTML).toContain('new-owner@example.test');
    expect(ui.area.innerHTML).not.toContain('a@example.test');
  });

  it('does not retain a different inbox result when continuing from stale controls', async () => {
    let release: (value: unknown) => void = () => {};
    const ui = retrieval(async path => path.includes('/a/')
      ? { messageId:'A', codes:[{type:'numeric',value:'123456',confidence:1,context:''}] }
      : new Promise(resolve => { release = resolve; }));
    await ui.getCode('a');
    const pending = ui.getCode('b', true, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ui.area.innerHTML).not.toContain('123456');
    release({ codes: [], scan: { reason: 'timeout' } });
    await pending;
  });

  it('does not let a late code overwrite a newly opened inbox message view', async () => {
    let release: (value: unknown) => void = () => {};
    const ui = retrieval(async path => path.endsWith('/messages') ? { messages:[], address:'b@example.test' }
      : new Promise(resolve => { release = resolve; }));
    const pending = ui.getCode('a');
    await new Promise(resolve => setTimeout(resolve, 0));
    await ui.viewInbox('b');
    const opened = ui.area.innerHTML;
    release({ messageId:'late', codes:[{type:'numeric',value:'654321',confidence:1,context:''}] });
    await pending;
    expect(ui.area.innerHTML).toBe(opened);
    expect([...ui.codeSession.ids('a')]).toEqual([]);
  });

  it('keeps a concurrent later inbox request in view when the earlier request finishes', async () => {
    let release: (value: unknown) => void = () => {};
    const ui = retrieval(async path => path.includes('/a/') ? new Promise(resolve => { release = resolve; })
      : { messageId:'B', codes:[{type:'numeric',value:'123456',confidence:1,context:''}] });
    const pending = ui.getCode('a');
    await new Promise(resolve => setTimeout(resolve, 0));
    await ui.getCode('b');
    release({ messageId:'A', codes:[{type:'numeric',value:'654321',confidence:1,context:''}] });
    await pending;
    expect(ui.area.innerHTML).toContain('123456');
    expect(ui.area.innerHTML).not.toContain('654321');
    expect([...ui.codeSession.ids('a')]).toEqual([]);
    expect([...ui.codeSession.ids('b')]).toEqual(['B']);
  });
});

// History continuation must keep the already loaded mail visible on failure,
// retry the same page, and ignore results after leaving the mailbox/identity.
describe('mailbox history actions', () => {
  function history(api: (path: string) => Promise<unknown>) {
    const source = readFileSync(resolve('src/public/js/views/inboxes.js'), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(/^export .*;\r?$/gm, '');
    const elements = new Map<string, { innerHTML: string }>();
    const context = { api, URLSearchParams, document: { getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '' }); return elements.get(id);
    } }, t: (key: string) => key, on: () => '', esc: String, _pageState: {},
      paginateTable: () => {}, console };
    return runInNewContext(source + `
      _mailboxCtx = { email:'pool@example.test', messages:[{id:'A'}],
        leaseById:{}, nextPageToken:'page-one', loading:false };
      ({ loadEarlierMailbox, invalidateCodeView, getState:()=>_mailboxCtx });`, context);
  }

  it('retains rows and retries the same continuation after a failed read', async () => {
    const requests: string[] = []; let fail = true;
    const ui = history(async path => {
      requests.push(path); if (fail) { fail = false; throw new Error('upstream failed'); }
      return { messages:[{id:'A'},{id:'B'}], nextPageToken:'page-two' };
    });
    await ui.loadEarlierMailbox();
    expect(ui.getState().messages.map((m: {id:string}) => m.id)).toEqual(['A']);
    expect(ui.getState().nextPageToken).toBe('page-one');
    await ui.loadEarlierMailbox();
    expect(requests[0]).toBe(requests[1]);
    expect(requests[1]).toContain('pageToken=page-one');
    expect(ui.getState().messages.map((m: {id:string}) => m.id)).toEqual(['A','B']);
    expect(ui.getState().nextPageToken).toBe('page-two');
  });

  it.each(['navigation', 'identity change'])('ignores a late history page after %s', async () => {
    let release: (value: unknown) => void = () => {};
    const ui = history(() => new Promise(resolve => { release = resolve; }));
    const before = ui.getState(); const pending = ui.loadEarlierMailbox();
    ui.invalidateCodeView();
    release({ messages:[{id:'B'}], nextPageToken:null }); await pending;
    expect(before.messages.map((m: {id:string}) => m.id)).toEqual(['A']);
    expect(ui.getState()).toBeNull();
  });
});
