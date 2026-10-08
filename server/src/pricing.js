'use strict';
// Estimated cost at Anthropic first-party API list prices (USD per million tokens).
// Subscription plans (Pro/Max/Team) do not bill per token; this is a *proxy* for how
// heavily a model is being used. Cache write defaults to 1.25x input, cache read to
// 0.1x input unless the model has a documented different cache-read rate.
const PRICES = [
  ['claude-fable-5-1',  { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5',    { input: 10, output: 50, cacheRead: 1.0 }],
  ['claude-mythos-5',   { input: 10, output: 50, cacheRead: 1.0 }],
  ['claude-opus-5-5',   { input: 4,  output: 20, cacheRead: 0.2 }],
  ['claude-opus-5',     { input: 5,  output: 25 }],
  ['claude-opus-4-8',   { input: 5,  output: 25 }],
  ['claude-opus-4-7',   { input: 5,  output: 25 }],
  ['claude-opus-4-6',   { input: 5,  output: 25 }],
  ['claude-opus-4-5',   { input: 5,  output: 25 }],
  ['claude-opus-4-1',   { input: 15, output: 75 }],
  ['claude-opus-4',     { input: 15, output: 75 }],
  ['claude-sonnet-5-5', { input: 2,  output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5',   { input: 2,  output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4-6', { input: 3,  output: 15 }],
  ['claude-sonnet-4-5', { input: 3,  output: 15 }],
  ['claude-sonnet-4',   { input: 3,  output: 15 }],
  ['claude-haiku-4-5',  { input: 1,  output: 5 }],
  ['claude-haiku-3-5',  { input: 0.8, output: 4 }],
  ['claude-3-5-haiku',  { input: 0.8, output: 4 }],
];

// "us.anthropic.claude-opus-5-5-20260401-v1:0" -> "claude-opus-5-5-20260401"
function canonicalModel(model) {
  if (!model || typeof model !== 'string') return 'unknown';
  let m = model.trim().toLowerCase();
  m = m.replace(/^(us|eu|apac|global)\.anthropic\./, '').replace(/^anthropic\./, '');
  m = m.replace(/-v\d+:\d+$/, '').replace(/@\d{8}$/, '');
  return m || 'unknown';
}

function priceFor(model) {
  const m = canonicalModel(model);
  // longest prefix wins ("claude-opus-5-5" before "claude-opus-5")
  let best = null;
  for (const [prefix, p] of PRICES) {
    if (m === prefix || m.startsWith(prefix + '-')) {
      if (!best || prefix.length > best[0].length) best = [prefix, p];
    }
  }
  if (!best) return null;
  const p = best[1];
  return {
    input: p.input,
    output: p.output,
    cacheWrite: p.cacheWrite ?? p.input * 1.25,
    cacheRead: p.cacheRead ?? p.input * 0.1,
  };
}

function estimateCost({ input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0 }, model) {
  const p = priceFor(model);
  if (!p) return 0;
  const M = 1_000_000;
  return (input_tokens * p.input + output_tokens * p.output +
    cache_read_tokens * p.cacheRead + cache_write_tokens * p.cacheWrite) / M;
}

// Coarse family used for colouring and for matching per-model rate-limit windows.
function modelFamily(model) {
  const m = canonicalModel(model);
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

module.exports = { canonicalModel, priceFor, estimateCost, modelFamily };
