'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser, inspectRequestBody, pickUsage } = require('../sse');

const sse = (obj) => 'event: x\ndata: ' + JSON.stringify(obj) + '\n\n';

test('parses a Messages-style stream split at awkward boundaries', () => {
  const stream =
    sse({ type: 'message_start', message: { model: 'claude-opus-5-5' } }) +
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'abcd' } }) +
    sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } }) +
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
    sse({ type: 'message_limit', message_limit: { type: 'within_limit' } }) +
    'data: [DONE]\n';
  const p = createParser();
  for (let i = 0; i < stream.length; i += 7) p.push(stream.slice(i, i + 7));
  const r = p.result();
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.outputChars, 15);
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.events, 6);
});

test('parses the legacy completion stream', () => {
  const p = createParser();
  p.push('data: {"completion":"Hi ","model":"claude-sonnet-4-5"}\r\n');
  p.push('data: {"completion":"there","stop_reason":"stop_sequence"}');
  const r = p.result();
  assert.equal(r.model, 'claude-sonnet-4-5');
  assert.equal(r.outputChars, 8);
  assert.equal(r.stopReason, 'stop_sequence');
});

test('finds the model in a non-SSE body', () => {
  const p = createParser();
  p.push('\u0000\u0012binary-ish claude-fable-5-1\u0000 more');
  assert.equal(p.result().model, 'claude-fable-5-1');
});

test('inspectRequestBody reads model and prompt size', () => {
  assert.deepEqual(inspectRequestBody(JSON.stringify({ prompt: 'hello', model: 'claude-haiku-4-5', attachments: [{ extracted_content: 'abc' }] })),
    { model: 'claude-haiku-4-5', promptChars: 8 });
  assert.deepEqual(inspectRequestBody(undefined), { model: null, promptChars: 0 });
  assert.equal(inspectRequestBody('raw claude-opus-5 text').model, 'claude-opus-5');
});

test('pickUsage drops everything except limit windows', () => {
  assert.deepEqual(Object.keys(pickUsage({ five_hour: 1, seven_day_sonnet: 2, limits: [], spend: 5 })), ['five_hour', 'seven_day_sonnet', 'limits']);
});
