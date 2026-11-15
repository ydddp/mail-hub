// Stand-ins for the Tampermonkey APIs the userscript uses. Storage and the fake
// Mail Hub live in serve.mjs so they survive navigations, including ones to a
// different *.localhost host (the real manager's storage is not per-origin).
(() => {
  const params = new URLSearchParams(location.search);
  let tabId = params.get('__tab') || sessionStorage.getItem('mh-dev-tab');
  if (!tabId) tabId = Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem('mh-dev-tab', tabId);
  window.__mhDevTab = tabId;

  function syncJson(method, url, body) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false); // the real GM_getValue is synchronous too
    if (body !== undefined) xhr.setRequestHeader('content-type', 'application/json');
    xhr.send(body === undefined ? null : JSON.stringify(body));
    return JSON.parse(xhr.responseText);
  }

  window.GM_getValue = (key, fallback) => {
    const result = syncJson('GET', `/__gm/get?k=${encodeURIComponent(key)}`);
    return result.has ? result.value : fallback;
  };
  window.GM_setValue = (key, value) => { syncJson('POST', '/__gm/set', { k: key, v: value }); };
  window.GM_deleteValue = (key) => { syncJson('POST', '/__gm/del', { k: key }); };
  window.GM_getTab = (callback) => {
    const result = syncJson('GET', `/__gm/tab/get?id=${encodeURIComponent(tabId)}`);
    setTimeout(() => callback(result.value ?? {}), 0);
  };
  window.GM_saveTab = (value, callback) => {
    syncJson('POST', '/__gm/tab/set', { id: tabId, v: value });
    if (callback) setTimeout(callback, 0);
  };

  window.__mhMenu = {};
  window.GM_registerMenuCommand = (caption, run) => { window.__mhMenu[caption] = run; };

  // Whatever base URL the panel was configured with, requests are answered by
  // the fake API on this dev server. Only the path and query are kept.
  window.GM_xmlhttpRequest = (details) => {
    const controller = new AbortController();
    let settled = false;
    const target = new URL(details.url);
    const timer = details.timeout ? setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      details.ontimeout?.();
    }, details.timeout) : null;

    fetch(`${target.pathname}${target.search}`, {
      method: details.method,
      headers: details.headers,
      body: details.data,
      signal: controller.signal,
    }).then(async (response) => {
      const text = await response.text();
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      details.onload?.({
        status: response.status,
        responseText: text,
        responseHeaders: [...response.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n'),
        finalUrl: details.url,
      });
    }).catch((error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      details.onerror?.({ status: 0, error: String(error) });
    });

    return {
      abort() {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        controller.abort();
        details.onabort?.();
      },
    };
  };
})();
