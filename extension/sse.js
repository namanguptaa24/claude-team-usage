// Runs in the claude.ai page (MAIN world) before inject.js.
// Pure helpers: parse the completion stream, inspect request bodies, trim usage JSON.
(function (root) {
  'use strict';
  const MODEL_ID_RE = /\bclaude-(?:fable|mythos|opus|sonnet|haiku)[a-z0-9.-]*/i;

  function textLen(v) { return typeof v === 'string' ? v.length : 0; }

  function createParser() {
    let buf = '';
    let sniff = '';
    let model = null;
    let outputChars = 0;
    let events = 0;
    let stopReason = null;

    function handleData(data) {
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { return; }
      if (!j || typeof j !== 'object') return;
      events++;
      if (j.type === 'message_start' && j.message && typeof j.message.model === 'string') {
        model = j.message.model;
      } else if (j.type === 'content_block_start' && j.content_block) {
        outputChars += textLen(j.content_block.text) + textLen(j.content_block.thinking);
      } else if (j.type === 'content_block_delta' && j.delta) {
        outputChars += textLen(j.delta.text) + textLen(j.delta.thinking) + textLen(j.delta.partial_json);
      } else if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) {
        stopReason = j.delta.stop_reason;
      } else if (typeof j.completion === 'string') {
        // legacy completion stream
        outputChars += j.completion.length;
        if (j.stop_reason) stopReason = j.stop_reason;
      }
      if (!model && typeof j.model === 'string' && j.model) model = j.model;
    }

    return {
      push(chunk) {
        if (sniff.length < 65536) sniff += chunk.slice(0, 65536 - sniff.length);
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line.startsWith('data:')) handleData(line.slice(5).trim());
        }
        if (buf.length > 4 * 1024 * 1024) buf = '';
      },
      result() {
        if (buf.startsWith('data:')) { handleData(buf.slice(5).trim()); buf = ''; }
        if (!model) { const m = MODEL_ID_RE.exec(sniff); if (m) model = m[0]; }
        return { model, outputChars, events, stopReason };
      },
    };
  }

  function inspectRequestBody(body) {
    const out = { model: null, promptChars: 0 };
    if (typeof body !== 'string') return out;
    try {
      const j = JSON.parse(body);
      if (j && typeof j === 'object') {
        out.model = typeof j.model === 'string' ? j.model : null;
        out.promptChars = textLen(j.prompt);
        for (const a of Array.isArray(j.attachments) ? j.attachments : []) out.promptChars += textLen(a && a.extracted_content);
        return out;
      }
    } catch { /* not JSON */ }
    out.promptChars = body.length;
    const m = MODEL_ID_RE.exec(body);
    if (m) out.model = m[0];
    return out;
  }

  function pickUsage(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of Object.keys(raw)) {
      if (/^(five_hour|seven_day)/i.test(k) || k === 'limits') out[k] = raw[k];
    }
    return out;
  }

  const api = { createParser, inspectRequestBody, pickUsage, MODEL_ID_RE };
  root.__ctuSse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
