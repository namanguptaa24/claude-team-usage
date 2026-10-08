'use strict';
// Builds the zip you send to teammates: the Claude Code installer, the Chrome extension,
// and a TEAMMATE-SETUP.txt with your server address. The server folder (with server/.env
// and everyone's data) is never included, and neither is the team token: send that separately.
//   node scripts/pack-teammates.js --server http://192.168.1.10:8787   -> dist/claude-team-usage.zip

const fs = require('node:fs');
const path = require('node:path');
const { listFiles, readEntries, zip } = require('./pack-extension');

const ROOT = path.join(__dirname, '..');

function setupText(server) {
  return `Claude Team Usage - setup for team members
==========================================

Our team shares one Claude account. This shows who uses how much of it.
It sends only counts (which model, how many tokens, when), never your
prompts, replies or code.

You need
--------
- Node.js, the LTS version from https://nodejs.org (if you don't have it yet).
- Google Chrome.
- The TEAM TOKEN. Ask the person who sent you this zip. It is not in the zip.

Use these values
----------------
Server address:  ${server}
Your name:       the part of your work email before the @, in lower case.
                 Example: ravi for ravi@example.com.
                 Use exactly the same name in step 2 and step 3.

1. Unzip
--------
Right-click the zip, choose "Extract All", and extract it to a folder you
will keep, for example Documents\\claude-team-usage.
Do not delete this folder later: Chrome runs the extension from it.

2. Claude Code (VS Code and terminal)
-------------------------------------
1. In the folder, double-click install-claude-code-hook.cmd.
2. A black window asks four questions. Type the answer and press Enter:
   - Server URL:  ${server}
   - Team token:  paste it (right-click in the window pastes)
   - Your name:   your name, see above
   - History:     30
3. Wait until it says "Done." Then press any key to close the window.

3. Chrome extension (claude.ai)
-------------------------------
1. Open Chrome and go to chrome://extensions
2. Turn on "Developer mode" (switch at the top right).
3. Click "Load unpacked".
4. Go into this folder, click once on the folder named "extension",
   then click "Select Folder". (Pick "extension", not the main folder.)
5. The settings page opens. Fill in the same server address, team token
   and name, then click Save. It should say "Saved. Connected ...".
6. Reload any claude.ai tabs you have open.

4. Check
--------
Click the puzzle icon in Chrome's toolbar and pin "Claude Team Usage".
Click its icon: your name and the shared account limits should show.

Something wrong? Send a screenshot to the person who sent you this zip.
`;
}

function packTeammates({ server = 'http://YOUR-SERVER:8787', outDir = path.join(ROOT, 'dist') } = {}) {
  const pick = (dir) => listFiles(path.join(ROOT, dir), dir);
  const files = [
    ...readEntries([
      { name: 'install-claude-code-hook.cmd', full: path.join(ROOT, 'install-claude-code-hook.cmd') },
      { name: 'README.md', full: path.join(ROOT, 'README.md') },
      { name: 'LICENSE', full: path.join(ROOT, 'LICENSE') },
    ]),
    ...readEntries(pick('claude-code-hook')),
    ...readEntries(pick('extension')),
    // CRLF so the file reads well in Notepad.
    { name: 'TEAMMATE-SETUP.txt', data: Buffer.from(setupText(server).replace(/\r?\n/g, '\r\n'), 'utf8'), mtime: new Date() },
  ];
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'claude-team-usage.zip');
  fs.writeFileSync(out, zip(files));
  return { out, files: files.map((f) => f.name) };
}

if (require.main === module) {
  const i = process.argv.indexOf('--server');
  const server = i > 0 ? String(process.argv[i + 1] || '').replace(/\/+$/, '') : undefined;
  if (i > 0 && !/^https?:\/\/\S+$/.test(server || '')) {
    console.error('Give the server address, e.g. --server http://192.168.1.10:8787');
    process.exit(1);
  }
  const r = packTeammates({ server });
  console.log('Packed ' + r.files.length + ' files into ' + r.out);
  if (!server) console.log('No --server given: TEAMMATE-SETUP.txt says http://YOUR-SERVER:8787.');
}

module.exports = { packTeammates };
