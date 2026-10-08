// Runs in the claude.ai page (MAIN world). Watches the page's own requests:
// when a message is sent it records the model and response size, then reads the
// account's usage percentages from claude.ai's usage endpoint (same session cookie
// the page already uses). Results go to the extension through window.postMessage.
(function () {
  'use strict';
  if (window.__ctuHooked || !window.__ctuSse) return;
  window.__ctuHooked = true;

  const SSE = window.__ctuSse;
  const nativeFetch = window.fetch;
  const ORG_RE = /\/api\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
  const CONV_RE = /\/chat_conversations\/([0-9a-f-]{36})/i;
  const SEND_RE = /\/(?:retry_)?completion\/?$|\/ConversationService\/PerformAction$/;
  const SNAPSHOT_DELAY = 2500;
  let orgId = null;
  let snapshotTimer = null;

  function post(type, payload) {
    try { window.postMessage({ __ctu: 1, type, payload }, location.origin); } catch { /* ignore */ }
  }

  function toUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href);
      if (input instanceof URL) return input;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href);
    } catch { /* ignore */ }
    return null;
  }

  async function findOrgId() {
    if (orgId) return orgId;
    const c = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/i);
    if (c) return (orgId = c[1]);
    try {
      const r = await nativeFetch.call(window, '/api/organizations', { credentials: 'include' });
      if (r.ok) {
        const list = await r.json();
        const pick = Array.isArray(list) && (list.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || list[0]);
        if (pick && pick.uuid) orgId = pick.uuid;
      }
    } catch { /* ignore */ }
    return orgId;
  }

  async function snapshotUsage() {
    const org = await findOrgId();
    if (!org) return;
    try {
      const r = await nativeFetch.call(window, '/api/organizations/' + org + '/usage', {
        credentials: 'include', headers: { Accept: 'application/json' },
      });
      if (!r.ok) return;
      const raw = SSE.pickUsage(await r.json());
      if (Object.keys(raw).length) post('snapshot', { snapshot_id: crypto.randomUUID(), ts: Date.now(), raw });
    } catch { /* ignore */ }
  }

  function scheduleSnapshot(delay) {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(snapshotUsage, delay);
  }

  async function lookupModel(conv) {
    const org = await findOrgId();
    if (!org || !conv) return null;
    try {
      const r = await nativeFetch.call(window, '/api/organizations/' + org + '/chat_conversations/' + conv + '?tree=False&rendering_mode=messages', { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      return (j && typeof j.model === 'string' && j.model) || null;
    } catch { return null; }
  }

  async function observe(response, ctx) {
    const parser = SSE.createParser();
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } catch { /* stream aborted (user pressed stop): count what arrived */ }
    const r = parser.result();
    const model = r.model || ctx.reqModel || (await lookupModel(ctx.conversationId)) || 'claude-unknown';
    post('message', {
      event_id: 'web:' + crypto.randomUUID(),
      ts: Date.now(),
      started_at: ctx.startedAt,
      model,
      output_chars: r.outputChars || (r.events === 0 ? Math.round(bytes * 0.8) : 0),
      prompt_chars: ctx.promptChars,
      conversation_id: ctx.conversationId,
    });
    scheduleSnapshot(SNAPSHOT_DELAY);
  }

  function wrappedFetch(input, init) {
    let ctx = null;
    try {
      const url = toUrl(input);
      if (url && url.origin === location.origin) {
        const org = ORG_RE.exec(url.pathname);
        if (org) orgId = org[1];
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'POST' && SEND_RE.test(url.pathname)) {
          const info = SSE.inspectRequestBody(init && init.body);
          ctx = {
            startedAt: Date.now(),
            conversationId: (CONV_RE.exec(url.pathname) || [])[1] || null,
            reqModel: info.model,
            promptChars: info.promptChars,
          };
        }
      }
    } catch { /* never interfere with the page */ }

    const p = nativeFetch.apply(this, arguments);
    if (!ctx) return p;
    return p.then((res) => {
      try {
        if (res.ok && res.body) observe(res.clone(), ctx);
        else scheduleSnapshot(1500);
      } catch { /* ignore */ }
      return res;
    });
  }

  window.fetch = wrappedFetch;
})();
