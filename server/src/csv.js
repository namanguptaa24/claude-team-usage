'use strict';
// CSV that Excel opens correctly: UTF-8 with a byte order mark, CRLF line ends,
// and quotes only where a value needs them.

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  // Excel runs a cell that starts with = + - @ as a formula. Member and model names
  // come from teammates' machines, so they are kept as plain text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { toCsv };
