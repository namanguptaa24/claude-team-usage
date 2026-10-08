'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalModel, priceFor, estimateCost, modelFamily } = require('../src/pricing');

test('canonicalModel strips provider prefixes and suffixes', () => {
  assert.equal(canonicalModel('us.anthropic.claude-opus-5-5-20260401-v1:0'), 'claude-opus-5-5-20260401');
  assert.equal(canonicalModel('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5');
  assert.equal(canonicalModel('  Claude-Fable-5-1 '), 'claude-fable-5-1');
  assert.equal(canonicalModel(null), 'unknown');
});

test('priceFor picks the longest matching prefix', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('claude-opus-5').input, 5);
  assert.equal(priceFor('claude-opus-5-20260101').input, 5);
  assert.equal(priceFor('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceFor('claude-unknown'), null);
});

test('estimateCost prices every token type', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write (1.25x)
  const cost = estimateCost({ input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: 1e6 }, 'claude-opus-5-5');
  assert.ok(Math.abs(cost - (4 + 20 + 0.2 + 5)) < 1e-9);
  assert.equal(estimateCost({ output_tokens: 1e6 }, 'some-other-model'), 0);
});

test('modelFamily groups models', () => {
  assert.equal(modelFamily('claude-fable-5-1'), 'fable');
  assert.equal(modelFamily('claude-mythos-5-1'), 'fable');
  assert.equal(modelFamily('claude-opus-4-8'), 'opus');
  assert.equal(modelFamily('claude-3-5-haiku-20241022'), 'haiku');
  assert.equal(modelFamily('claude-unknown'), 'other');
});
