#!/usr/bin/env node
'use strict';
// Removes the Claude Code usage reporter hooks.
//   node uninstall.js           remove the hooks, keep ~/.claude/team-usage
//   node uninstall.js --purge   also delete ~/.claude/team-usage (config, queue, log)

const fs = require('node:fs');
const path = require('node:path');
const { claudeDir, readJson, writeJsonAtomic, removeOurHooks } = require('./lib/common');

const settingsPath = path.join(claudeDir(), 'settings.json');
const settings = readJson(settingsPath, null);
if (settings && settings.hooks && typeof settings.hooks === 'object') {
  for (const ev of Object.keys(settings.hooks)) {
    const groups = removeOurHooks(settings.hooks[ev]);
    if (groups.length) settings.hooks[ev] = groups;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJsonAtomic(settingsPath, settings);
  console.log('Removed the hooks from ' + settingsPath);
} else {
  console.log('No hooks found in ' + settingsPath);
}

if (process.argv.includes('--purge')) {
  fs.rmSync(path.join(claudeDir(), 'team-usage'), { recursive: true, force: true });
  console.log('Deleted ' + path.join(claudeDir(), 'team-usage'));
}
