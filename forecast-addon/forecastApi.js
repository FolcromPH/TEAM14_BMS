// SOH forecasting add-on: one extra endpoint, GET /api/forecast, for the ORIGINAL Worker.
//
// It only READS the `readings` and `battery_identities` tables that already exist, so it needs no
// migration and no change to how the ESP32 posts data. A "cycle" is one step of the stored SOH value
// (the SOH only changes once per completed cycle). Steps closer together than minGapSeconds are merged,
// so a firmware that reports a slightly different SOH on every reading still gives one point per window.
import { buildForecast } from './forecast.js';

const CACHE_MS = 5 * 60 * 1000;      // the SOH steps are re-read at most every 5 minutes per battery
const MIN_GAP_SECONDS = 300;
const MAX_CYCLES = 5000;
const caches = new WeakMap();   // one cache per database binding

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const finite = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));

// Merge SOH steps that are closer than minGapMs (keeps the later value) and number them 1..n.
export function stepsToCycles(steps, minGapMs = MIN_GAP_SECONDS * 1000) {
  const kept = [];
  // the first stored SOH is the starting value, not a completed cycle
  for (const step of steps.slice(1)) {
    const last = kept[kept.length - 1];
    if (last && step.timestamp_ms - last.timestamp_ms < minGapMs) kept[kept.length - 1] = step;
    else kept.push(step);
  }
  return kept.slice(-MAX_CYCLES).map((step, index) => ({
    cycle: index + 1,
    sohRaw: step.soh,
    sohReported: step.soh,
    endedMs: step.timestamp_ms,
  }));
}

async function loadSteps(db, identity) {
  const column = `battery${identity.slot}_soh`;
  const identityColumn = `battery${identity.slot}_identity_id`;
  const { results } = await db.prepare(`
    SELECT timestamp_ms, soh FROM (
      SELECT timestamp_ms, ${column} AS soh,
             LAG(${column}) OVER (ORDER BY timestamp_ms) AS prev
      FROM readings
      WHERE ${identityColumn} = ? AND ${column} IS NOT NULL
    )
    WHERE prev IS NULL OR ABS(soh - prev) > 0.000001
    ORDER BY timestamp_ms ASC
  `).bind(identity.id).all();
  return results.map((row) => ({ timestamp_ms: Number(row.timestamp_ms), soh: Number(row.soh) }));
}

export async function handleForecast(request, env) {
  try {
    const db = env.battery_management_db;
    const params = new URL(request.url).searchParams;
    const { results: identities } = await db.prepare(`
      SELECT i.id, i.slot, i.name, i.voltage_v, i.capacity_mah, i.created_at_ms,
             EXISTS (SELECT 1 FROM battery_specs s WHERE s.identity_id = i.id) AS active
      FROM battery_identities i
      ORDER BY active DESC, i.slot ASC, i.id DESC
    `).all();
    const list = identities.map((item) => ({ ...item, active: Boolean(item.active) }));
    const requested = finite(params.get('batteryId'));
    const identity = list.find((item) => item.id === requested) ?? list.find((item) => item.active) ?? list[0];
    if (!identity) return json({ batteryIdentities: [], identity: null, forecast: buildForecast([]), cycles: [] });

    const options = {};
    const threshold = finite(params.get('threshold'));
    const horizon = finite(params.get('horizon'));
    if (threshold !== null && threshold > 0 && threshold < 100) options.threshold = threshold;
    if (horizon !== null && horizon >= 1 && horizon <= 200) options.horizon = Math.round(horizon);

    if (!caches.has(db)) caches.set(db, new Map());
    const cache = caches.get(db);
    let entry = cache.get(identity.id);
    if (!entry || Date.now() - entry.at > CACHE_MS || params.get('refresh') === '1') {
      entry = { at: Date.now(), cycles: stepsToCycles(await loadSteps(db, identity)) };
      cache.set(identity.id, entry);
    }

    return json({
      batteryIdentities: list,
      identity: { id: identity.id, slot: identity.slot, name: identity.name, ratedCapacityAh: identity.capacity_mah / 1000 },
      forecast: buildForecast(entry.cycles, options),
      cycles: entry.cycles.slice(-30).map((cycle) => ({
        number: cycle.cycle, endedAtMs: cycle.endedMs, sohRaw: cycle.sohRaw, sohReported: cycle.sohReported,
      })),
    });
  } catch (error) {
    return json({ error: error.message || 'Could not build the forecast' }, 500);
  }
}
