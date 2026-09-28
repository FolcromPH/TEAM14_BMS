# Google Sheets sync

The Worker batches D1 telemetry into a Google Sheet once per minute. It retries unsent rows on later runs and starts with the oldest D1 reading, so existing database history is backfilled too. The `Readings` sheet keeps Battery 1 and Battery 2 values in separate columns.

## 1. Create the Apps Script endpoint

1. Create a Google spreadsheet and copy its ID from the URL between `/d/` and `/edit`.
2. Open **Extensions > Apps Script** for that spreadsheet. Replace the editor contents with [`Code.gs`](Code.gs) and save.
3. In **Project Settings > Script properties**, add:
   - `SPREADSHEET_ID`: the spreadsheet ID from step 1.
   - `SYNC_TOKEN`: a long random token. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Choose **Deploy > New deployment > Web app**. Set **Execute as** to yourself and access to **Anyone**, then deploy and copy the web app URL ending in `/exec`.

The endpoint must be accessible to the Worker. The random shared token is checked by the script; do not put it in the spreadsheet or commit it to source control.

## 2. Configure local development

Add these values to the ignored `.dev.vars` file in the app root:

```dotenv
GOOGLE_SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
GOOGLE_SHEETS_SYNC_TOKEN=the-same-random-token-from-script-properties
```

Restart `npm run dev:worker` after changing `.dev.vars`. The dashboard's Database reader tab will show whether the required Worker settings are present.

## 3. Configure Cloudflare

From the app root, apply the new D1 migration and add the webhook settings as Worker secrets:

```powershell
npx wrangler d1 migrations apply battery-management-db --remote
npx wrangler secret put GOOGLE_SHEETS_WEBHOOK_URL
npx wrangler secret put GOOGLE_SHEETS_SYNC_TOKEN
npm run deploy
```

Enter the `/exec` URL and the same random token when Wrangler prompts. Keep the token private. The cron trigger is configured in `wrangler.jsonc`; once deployed, it sends up to 500 unsynced rows every minute and advances its D1 cursor only after the endpoint confirms success.

On first setup it backfills stored readings in batches. Later readings continue syncing automatically. The script uses Reading ID in the first column to avoid appending duplicates if an unsuccessful request is retried.
