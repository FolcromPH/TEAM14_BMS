# SOH forecast add-on

Use this if you do **not** want to change the rest of the project and only want to add the forecasting model to the system you already have. It adds one API route and one dashboard panel. It does not need a database migration, does not touch the ESP32 firmware or the switching/command code, and only reads the `readings` and `battery_identities` tables that already exist.

| File | What it is |
| --- | --- |
| `forecast.js` | The model: straight-line fit of SOH against cycle number, walk-forward backtest, error range, cycles until 80 %. Plain JavaScript, no dependencies. |
| `forecastApi.js` | `handleForecast(request, env)` - the `GET /api/forecast` handler for the Worker. |
| `SohForecastPanel.jsx` + `sohForecast.css` | A self-contained React panel (battery picker, numbers, chart with the error band). |

## Install (4 small edits)

1. Copy this whole `forecast-addon` folder into the project root, next to `src/`.

2. **Worker** - in `src/worker.js` add the import at the top of the file:

   ```js
   import { handleForecast } from '../forecast-addon/forecastApi.js';
   ```

   and one line in the route list inside `fetch()`, for example right above the `/api/health` line:

   ```js
   if (pathname === '/api/forecast' && request.method === 'GET') return handleForecast(request, env);
   ```

3. **Dashboard** - in `src/AnalyticsPanel.jsx` add:

   ```jsx
   import SohForecastPanel from '../forecast-addon/SohForecastPanel.jsx'
   ```

   and render `<SohForecastPanel />` just before the closing `</section>` of the component's return (below the existing analytics content).

4. Run `npm run build` (or `npm run dev:worker` and `npm run dev`) and open **Analytics**.

Nothing else changes. To remove the add-on, undo the four edits and delete the folder.

## How it decides what a "cycle" is

SOH is only supposed to change once per completed cycle, so the add-on reads, for the chosen battery, every point where the stored SOH value **changes** (a `LAG` query over its `readings`). The first stored value is the starting point; each later change is one cycle. Changes closer than 5 minutes are merged (the later value wins), so a firmware that stores a slightly different SOH on every reading still produces one point per window. If your SOH column is empty (`NULL`) there is nothing to forecast and the panel says so.

The result is cached for 5 minutes per battery inside the Worker, because the query scans that battery's readings. Add `?refresh=1` to `/api/forecast` to bypass the cache.

## What it reports

- The predicted SOH of the next cycle and its **error range**, in percentage points and in percent. The range is measured: for each cycle from the sixth on, a line is fitted to the earlier cycles, its prediction is compared with the SOH that was then actually recorded, and the 90th-percentile miss becomes the +/- range. The mean miss and the share of forecasts within 5 points are shown too.
- Until about 8 cycles exist the range is a labelled assumption of +/-5 %.
- Fade per cycle, R squared of the fit, and the cycle where the line reaches 80 % SOH (earliest / expected / latest, and days if the cycles have timestamps).
- A 20-cycle projection drawn with its band. Optional query parameters: `?batteryId=ID`, `?threshold=80`, `?horizon=20`.

## Limits

- The forecast is only as good as the stored SOH. This add-on cannot improve how SOH itself is calculated; that is what the full version (`src/lib/health.js`) does.
- A straight line is a good model for the early, steady part of battery ageing. It will not predict the knee at the end of life.
- With fewer than 3 cycles there is no line; with fewer than 8 the error range is only assumed.

## Tests

`npm test` includes `tests/addon.test.mjs`, which runs the add-on against the original database schema (migrations 0001-0009 only) and checks that `forecast.js` here is identical to `src/lib/forecast.js`. If you change one, copy it to the other.
