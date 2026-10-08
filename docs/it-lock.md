# Lock the Claude Team Usage extension with Chrome policy

For the Google Workspace admin of a team that uses Claude Team Usage.

The Claude Team Usage Chrome extension counts which work profile uses Claude on claude.ai and sends the counts to the team's own usage server. When people install it by hand, anyone can switch it off or remove it.

With the steps below the extension is installed by policy. People cannot disable or remove it, its settings come from the policy, and each person's usage is reported under their work email name, so nobody can report as someone else. It only takes effect in Chrome profiles signed in with an account of your Google Workspace domain.

Plan for about an hour of admin work, plus a few days for the Chrome Web Store review.

## What the extension sends

Only to your own usage server: the person's name, the Claude model, an estimated token count per message, timestamps, and the account's usage percentage. It never sends prompts, replies or cookies. The full list is in the README, under Privacy.

## What you need

- Super admin access to the Google Admin console.
- A Chrome Web Store developer account registered with an address in your Google Workspace domain. Registration costs a one-time 5 USD fee.
- `claude-team-usage-extension-<version>.zip`. Ask the server admin, or build it in the project folder with `npm run pack-extension`. The file appears in `dist/`.
- The **team token**. The server admin gives you this separately. It is the `TEAM_TOKEN` line in `server/.env` on the server PC. Treat it like a password.

## 1. Allow publishing to your domain

Admin console, then **Devices > Chrome > Apps & extensions > Users & browsers > Additional settings > Chrome Web Store permissions**. Allow publishing private apps and extensions that are restricted to the domain.

## 2. Publish the extension privately

1. In the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole), sign in with that account. Choose **New item** and upload the zip.
2. **Store listing**
   - Category: any of the productivity categories.
   - Description: *Shows a team how much of its Claude usage limit each person uses, by counting messages and models on claude.ai and sending the counts to the team's own server.*
   - Screenshot: `docs/store/screenshot-1280x800.png` from the project.
   - Icon: taken from the zip.
3. **Privacy practices**
   - Single purpose: *Count each team member's Claude usage on claude.ai for the team's internal usage dashboard.*
   - Permission justifications:
     - `storage`: keeps the server address, the team token, and the counts waiting to be uploaded.
     - `alarms`: retries uploads every 5 minutes if the server was unreachable.
     - `identity`, `identity.email`: reads the signed-in work email when the policy sets `memberFromEmail`, so usage is reported under the right name.
     - Host permission `https://claude.ai/*`: reads which model answered and how long the reply was, plus claude.ai's own usage percentage.
   - Remote code: **No**.
   - Data usage: tick *Personally identifiable information* (the name) and *User activity* (message counts), and certify the three statements.
   - Privacy policy URL: required. Publish the README's Privacy section on a company page or a Google Site and link it.
4. **Distribution**: visibility **Private**, limited to your domain.
5. Submit it for review.
6. Write down the **item ID** shown in the dashboard (32 letters). It differs from the ID of the copy people loaded by hand.

## 3. Force-install it

Admin console, then **Devices > Chrome > Apps & extensions > Users & browsers**:

1. Select the organizational unit for the team. To test first, use a small test unit.
2. Click **+**, then **Add Chrome app or extension by ID**. Paste the item ID and choose **From the Chrome Web Store**.
3. Installation policy: **Force install + pin to browser toolbar**.
4. In **Policy for extensions**, paste the JSON below. Put in your server address and the real team token:

   ```json
   {
     "serverUrl": { "Value": "http://YOUR-SERVER:8787" },
     "teamToken": { "Value": "PASTE-THE-TEAM-TOKEN-HERE" },
     "memberFromEmail": { "Value": true }
   }
   ```

   What each setting does:
   - `serverUrl`: your usage server, for example `http://192.168.1.10:8787` on an office network. People cannot change it.
   - `teamToken`: the upload password. It is hidden from people.
   - `memberFromEmail`: the name becomes the part of the work email before the `@`. For example, `ravi@example.com` is reported as `ravi`.
5. Save.

## 4. Turn off incognito (recommended)

Extensions do not run in incognito windows. In **Devices > Chrome > Settings > Users & browsers**, search for **Incognito mode** and set it to **Disallow incognito mode**.

## 5. Check one PC

On a team member's PC, signed in to Chrome with their work account:

1. Open `chrome://policy` and click **Reload policies**.
2. Open `chrome://extensions`. **Claude Team Usage** should say it is installed by your administrator. The **Remove** button should be gone and the on/off switch greyed out.
3. Click the extension icon, then **Settings**. The page should say *Set by your company: server address, team token, your name (from your work email)*, with all three fields greyed out.
4. Click **Test connection**. It should say *Connected*.

If step 3 still shows empty, editable fields, the policy JSON did not reach the extension. Check the extension's entry on `chrome://policy`. If it shows an error, try the same JSON without the `{ "Value": ... }` wrappers, for example `"serverUrl": "http://YOUR-SERVER:8787"`.

## Good to know

- **Remove the hand-installed copy.** Each person should click **Remove** on the copy they loaded with **Load unpacked**. Otherwise both copies run and their usage counts twice.
- **Keep the server address fixed.** If the server PC gets its address from the office router (DHCP), reserve that address for it in the router. Otherwise it can change and every PC loses the connection.
- **Names have to match.** The Claude Code (VS Code / terminal) tracker asks for a name when it is installed. It should be the same email name. If two names end up for one person, the manager can merge them in the dashboard under **Manage team > Rename**.
- **What this does not cover.** Claude used from a phone, another browser, or the Claude desktop app is not seen by the extension.
- **Updating the extension.** Raise `version` in `extension/manifest.json`, run `npm run pack-extension`, and upload the new zip as a new version of the same item. Chrome updates the installed copies on its own.
