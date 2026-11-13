# NPD QA AXO Tracker

A Google Apps Script web app where NPD QAs log their updates on AXOs. QAs don't add AXOs:
new ones come in by themselves from the **#axo-assignments** Slack channel (posted by the
"NPD Axo Assignment" workflow). If Slack sync isn't set up, anyone can add an AXO with
**Paste AXO**, which reads a copied Slack post with the same parser.

This is a separate project from the NPD QA Endorsement Tracker. It has its own Sheet,
its own Apps Script project and its own deployment, and shares nothing with it. It uses the
ShipERP colours with its own layout: a shift header, queues, AXO cards and a side panel with
the update form and history.

## What QAs do

1. Pick their name at the top right (remembered per browser).
2. Open the AXO they worked on from a queue (**Needs a QA**, **My AXOs**, **Due in 2 days**,
   **Blocked or failing**, ...), or use **Add update** at the top.
3. In the side panel, record status, shift date, shift (Day / Mid / Night), notes and test
   file links. The shift date and shift default to the current Manila shift.

Every update is kept, so an AXO shows its full history and everyone who worked on it.
Several QAs can update the same AXO. An update with **Passed - Develop/Deployment** closes
the AXO; **Reopen** in the AXO panel brings it back, and **Mark closed** closes one by hand.

Statuses: Not Tested, In Progress, Passed - Initial, Passed - Develop/Deployment,
Failed - Initial, Failed - Develop/Deployment, Needs Monitoring, Urgent/High Prio, Blocked.

## Files

| File | What it is |
|---|---|
| `Code.gs` | Server: Sheet storage, Slack sync, web app API |
| `Parser.gs` | The one AXO parser used by both Slack sync and Paste AXO |
| `Index.html`, `Styles.html`, `Script.html` | The web app page |
| `appsscript.json` | Manifest (time zone, scopes, web app access) |
| `tests/`, `tools/` | Local tests and preview. Not uploaded to Apps Script |

## Setup

### 1. Sheet and script

1. Create a **new** Google Sheet, e.g. "NPD QA AXO Tracker".
2. **Extensions > Apps Script**.
3. Replace `Code.gs` with this repo's `Code.gs`. Add a script file **`Parser`** and paste `Parser.gs`.
4. Add three HTML files named exactly **`Index`**, **`Styles`**, **`Script`** and paste the matching files.
5. **Project Settings > Show "appsscript.json"**, then paste this repo's `appsscript.json`.
6. Reload the Sheet. An **AXO Tracker** menu appears. Run **AXO Tracker > Set up tabs** and approve the permissions.
7. In the **QAs** tab, list the QA names in column A (one per row). Put `FALSE` in column B to hide someone who left.

### 2. Slack sync (skip if you can't install a Slack app; Paste AXO still works)

The sync reads #axo-assignments as **you**, using a Slack user token. No bot joins the
channel and the workflow is not changed.

1. Go to <https://api.slack.com/apps> > **Create New App > From scratch**, pick your workspace.
2. **OAuth & Permissions > User Token Scopes**: add `groups:history` (private channel history)
   and `users:read` (to show names instead of user IDs).
3. **Install to Workspace** and approve. Copy the **User OAuth Token** (starts with `xoxp-`).
   If your workspace requires admin approval, the install button turns into a request.
4. Get the channel ID: open #axo-assignments in Slack > channel name > the ID is at the bottom
   of the About tab (starts with `C` or `G`).
5. In Apps Script **Project Settings > Script Properties**, add:

| Property | Value |
|---|---|
| `SLACK_USER_TOKEN` | the `xoxp-…` token |
| `SLACK_CHANNEL_ID` | the channel ID |
| `SLACK_REPLY_WINDOW_DAYS` | optional, default `3`: how many days back each run re-checks for late "assigned to" replies |

6. In the Sheet: **AXO Tracker > Test Slack connection**. Check **Executions** in Apps Script:
   it should list the last few posts parsed as AXOs.
7. **AXO Tracker > Import last 30 days from Slack** (one-time backfill).
8. **AXO Tracker > Start auto-sync (every 5 min)**.

Keep the token private. It can read every private channel you are in, and it lives only in
Script Properties, which only editors of the script can see. Don't share edit access to the
script project. If the token leaks, revoke it from the Slack app page.

The web app shows the sync state in the top bar ("Synced 3 min ago", or the error if the last
run failed). Errors are also kept in the `SLACK_LAST_ERROR` property.

### 3. Deploy

1. **Deploy > New deployment > Web app**.
2. **Execute as: Me**. **Who has access: Anyone with Google account** (or your Workspace domain).
3. Copy the web app URL and share it with the QAs.

After code changes: **Deploy > Manage deployments > Edit > New version** to keep the same URL.
The sync trigger always runs the latest saved code.

## How parsing works

`Parser.gs` reads posts like:

```
Axo Number: 15611 - [Frontend] - Bug AXO: OTM: Importer Details Change after Ship Confirmation
Priority: High
Link: https://….axosoft.com/…
Additional Info: …
Raised By: @Name
Due Date: Nov 20, 2026
Client: …
Ticket Number: …
```

Labels can be bold, have or lack a colon, and sit on the same line as the value or the line
above it. Additional Info can run over several lines. A reply like
`@Dev assigned to Axo 15611 - …` sets the dev assignee. AXOs are de-duplicated by number:
a repeat post or paste only fills in blank fields and never creates a second row or reopens
a closed AXO.

If the real workflow output differs from this, paste a sample into Paste AXO and press
**Check** to see what gets picked up, then adjust the label list at the top of `Parser.gs`.

## Sheet tabs

- **AXOs**: one row per AXO. `State` is Active or Closed. `DevAssignees` is a JSON list.
- **Updates**: one row per QA update. `Files` is a JSON list of `{name, url}`.
- **QAs**: names for the picker.

Avoid editing the AXOs and Updates tabs by hand while people are using the app.

## Local development

```
npm test           # parser + backend tests (Node 18+, no installs)
npm run preview    # http://localhost:8788 with dummy data, nothing saved
```
