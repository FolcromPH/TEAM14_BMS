import { HEALTH_DEFAULTS, isRestMode, processTelemetry, scoreCycle, stepSoc } from './lib/health.js';
import { buildForecast } from './lib/forecast.js';
import { CSV_HEADERS, formatTimestamp, readingToCsvLine } from './lib/csv.js';

const BATTERY_FIELDS = [
  'connected', 'voltage', 'current', 'power', 'temperature', 'soc', 'soh', 'status',
  'soc_kalman', 'soc_coulomb', 'soc_ocv', 'soh_pct', 'soh_relative_pct',
  'measuredCapacityAh', 'capacityAh', 'capacity_ah', 'effective_capacity_Ah',
];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_RANGE_MS = 366 * DAY_MS;
const DEFAULT_RECONNECT_GAP_SECONDS = 120;
const RECHAIN_ROW_LIMIT = 5000;

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(record, names) {
  for (const name of names) {
    const value = number(record?.[name]);
    if (value !== null) return value;
  }
  return null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function capacityForBattery(env, index, batterySpecs = {}) {
  const inventoryCapacityAh = number(batterySpecs[index]?.capacity_mah) / 1000;
  if (inventoryCapacityAh > 0) return inventoryCapacityAh;

  const configuredCapacity = number(env[`BATTERY${index}_CAPACITY_AH`]);
  return configuredCapacity > 0
    ? configuredCapacity
    : number(env.BATTERY_CAPACITY_AH) ?? 100;
}

function healthParams(env) {
  const params = { ...HEALTH_DEFAULTS };
  const overrides = {
    chargeEfficiency: env.CHARGE_EFFICIENCY,
    minDodPercent: env.MIN_DOD_PERCENT,
    ocvVoltsPerPercent: env.OCV_VOLTS_PER_PERCENT,
    ocvFullVoltage: env.OCV_FULL_VOLTAGE,
  };
  for (const [key, value] of Object.entries(overrides)) {
    const parsed = number(value);
    if (parsed !== null && parsed > 0) params[key] = parsed;
  }
  return params;
}

function normalizeBattery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    BATTERY_FIELDS
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
}

function batteryWithHealth(value, soc, soh) {
  const battery = JSON.parse(value || '{}');
  if (battery.connected === false) return { ...battery, soc: null, soh: null };
  return { ...battery, soc, soh };
}

function engineReading(battery) {
  const voltage = number(battery.voltage);
  return {
    connected: battery.connected !== false && voltage !== null,
    voltage,
    current: firstNumber(battery, ['current', 'currentA', 'amps']),
    reportedSoc: firstNumber(battery, ['soc_kalman', 'soc_coulomb', 'soc_ocv', 'soc']),
  };
}

function reportedSohFrom(battery) {
  const reported = firstNumber(battery, ['soh_relative_pct', 'soh_pct', 'soh']);
  return reported === null ? null : clampPercent(reported);
}

function healthForBattery(battery, soc, soh, env, index, batterySpecs, cycleInfo = null) {
  const hasSignal = battery.connected === true || Object.entries(battery).some(
    ([field, value]) => field !== 'connected' && value !== null && value !== undefined,
  );
  const capacityAh = firstNumber(battery, [
    'measuredCapacityAh', 'capacityAh', 'capacity_ah', 'effective_capacity_Ah',
  ]) ?? cycleInfo?.capacity_ah ?? null;

  return {
    soc: hasSignal ? soc : null,
    soh: hasSignal ? soh : null,
    capacityAh,
    ratedCapacityAh: capacityForBattery(env, index, batterySpecs),
    cycleCount: cycleInfo?.cycles ?? 0,
    lastCycleAtMs: cycleInfo?.ended_at_ms ?? null,
    ...(!hasSignal ? { error: 'Battery not reporting live data' } : {}),
    source: 'd1',
  };
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

// ---------------------------------------------------------------------------------------------
// Time ranges (relative presets or a custom from/to window, so old data such as Dataset_2.csv
// can be looked up by its own timestamps)
// ---------------------------------------------------------------------------------------------

function resolveRange(searchParams, presets, fallback) {
  const from = number(searchParams.get('from'));
  const to = number(searchParams.get('to'));
  if (from !== null && to !== null && to > from) {
    const endMs = to;
    const startMs = Math.max(from, endMs - MAX_CUSTOM_RANGE_MS);
    return { key: 'custom', startMs, endMs, rangeMs: endMs - startMs, custom: true };
  }
  const requested = searchParams.get('range');
  const key = requested && Object.hasOwn(presets, requested) ? requested : fallback;
  const endMs = Date.now();
  return { key, startMs: endMs - presets[key], endMs, rangeMs: presets[key], custom: false };
}

// ---------------------------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------------------------

async function getLatestReading(db) {
  return db.prepare(`
        SELECT id, battery1_identity_id, battery2_identity_id,
          timestamp_ms, mode, switching, wifi_json, system_json,
           battery1_json, battery2_json,
           battery1_soc, battery2_soc, battery1_soh, battery2_soh
    FROM readings
    ORDER BY timestamp_ms DESC
    LIMIT 1
  `).first();
}

async function getBatterySpecs(db) {
  const result = await db.prepare(`
    SELECT slot, name, voltage_v, capacity_mah, updated_at_ms, identity_id
    FROM battery_specs
    ORDER BY slot
  `).all();
  return Object.fromEntries(result.results.map((battery) => [battery.slot, battery]));
}

async function getBatteryIdentities(db) {
  const [identities, currentBatteries] = await Promise.all([
    db.prepare(`
      SELECT id, slot, name, voltage_v, capacity_mah, created_at_ms, full_voltage_v
      FROM battery_identities
      ORDER BY created_at_ms DESC, id DESC
    `).all(),
    getBatterySpecs(db),
  ]);
  return identities.results.map((identity) => ({
    ...identity,
    active: currentBatteries[identity.slot]?.identity_id === identity.id,
  }));
}

async function lastRecordedForIdentity(db, slot, identityId) {
  return db.prepare(`
    SELECT timestamp_ms, battery${slot}_soc AS soc, battery${slot}_soh AS soh
    FROM readings
    WHERE battery${slot}_identity_id = ? AND battery${slot}_soc IS NOT NULL
    ORDER BY timestamp_ms DESC
    LIMIT 1
  `).bind(identityId).first();
}

async function latestIdentityCycle(db, identityId) {
  return db.prepare(`
    SELECT capacity_ah, soh_raw, soh_reported, ended_at_ms,
           (SELECT COUNT(*) FROM battery_cycles WHERE identity_id = ? AND soh_reported IS NOT NULL) AS cycles
    FROM battery_cycles
    WHERE identity_id = ? AND soh_reported IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).bind(identityId, identityId).first();
}

async function scoringContext(db, identityId) {
  const [baseline, recent, last, count] = await Promise.all([
    db.prepare(`
      SELECT capacity_ah FROM battery_cycles
      WHERE identity_id = ? AND soh_raw IS NOT NULL
      ORDER BY id ASC LIMIT 1
    `).bind(identityId).first(),
    db.prepare(`
      SELECT soh_raw FROM battery_cycles
      WHERE identity_id = ? AND soh_raw IS NOT NULL
      ORDER BY id DESC LIMIT ?
    `).bind(identityId, HEALTH_DEFAULTS.medianWindow).all(),
    db.prepare(`
      SELECT soh_reported FROM battery_cycles
      WHERE identity_id = ? AND soh_reported IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).bind(identityId).first(),
    db.prepare(`
      SELECT COUNT(*) AS n FROM battery_cycles
      WHERE identity_id = ? AND soh_reported IS NOT NULL
    `).bind(identityId).first(),
  ]);
  return {
    baselineAh: baseline?.capacity_ah ?? null,
    recentRaw: recent.results.map((row) => row.soh_raw).reverse(),
    lastReported: last?.soh_reported ?? null,
    usableCount: count?.n ?? 0,
  };
}

function slotStateStatement(db, slot, row) {
  return db.prepare(`
    INSERT INTO slot_state (slot, identity_id, soc, ts_ms, connected, tracker_json, soh)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET
      identity_id = excluded.identity_id,
      soc = excluded.soc,
      ts_ms = excluded.ts_ms,
      connected = excluded.connected,
      tracker_json = excluded.tracker_json,
      soh = excluded.soh
  `).bind(
    slot, row.identityId ?? null, row.soc ?? null, row.tsMs ?? null, row.connected ? 1 : 0,
    row.tracker ? JSON.stringify(row.tracker) : null, row.soh ?? null,
  );
}

async function getSessionRow(db) {
  return (await db.prepare('SELECT * FROM connection_sessions WHERE id = 1').first())
    ?? { pending: 0, since_reading_id: null };
}

// Running state of both sensor slots. When the saved battery in a slot changed (renamed, picked from
// the saved list, or a new one), the state is rebuilt from that battery's own last recorded data.
async function loadEngineState(db, env, batterySpecs, identities, hasAnyReading) {
  const stored = (await db.prepare(`
    SELECT slot, identity_id, soc, ts_ms, connected, tracker_json, soh FROM slot_state
  `).all()).results;
  const bySlot = Object.fromEntries(stored.map((row) => [row.slot, row]));
  const slots = {};
  const soh = {};
  const known = {};

  for (const slot of [1, 2]) {
    const identityId = batterySpecs[slot]?.identity_id ?? null;
    const identity = identities.find((item) => item.id === identityId);
    let row = bySlot[slot];
    let rebuilt = false;
    if (!row || row.identity_id !== identityId) {
      const last = identityId ? await lastRecordedForIdentity(db, slot, identityId) : null;
      const cycle = identityId ? await latestIdentityCycle(db, identityId) : null;
      row = {
        identity_id: identityId,
        soc: last?.soc ?? (hasAnyReading ? null : (number(env.INITIAL_SOC) ?? 100)),
        ts_ms: null,
        connected: 0,
        tracker_json: null,
        soh: cycle?.soh_reported ?? last?.soh ?? null,
      };
      rebuilt = true;
    }
    let tracker = null;
    try { tracker = row.tracker_json ? JSON.parse(row.tracker_json) : null; } catch { tracker = null; }
    slots[slot] = {
      capacityAh: capacityForBattery(env, slot, batterySpecs),
      soc: number(row.soc),
      tsMs: number(row.ts_ms),
      tracker,
      fullVoltage: number(identity?.full_voltage_v),
      connected: Boolean(row.connected),
    };
    soh[slot] = number(row.soh);
    known[slot] = !rebuilt && row.ts_ms !== null && row.ts_ms !== undefined;
  }
  return { state: { slots }, soh, known };
}

// ---------------------------------------------------------------------------------------------
// Saved batteries (by name) and the "same or new?" confirmation
// ---------------------------------------------------------------------------------------------

async function identityStats(db, identity, env) {
  const slot = identity.slot;
  const [last, cycle, cycleTotal] = await Promise.all([
    lastRecordedForIdentity(db, slot, identity.id),
    latestIdentityCycle(db, identity.id),
    db.prepare('SELECT COUNT(*) AS n FROM battery_cycles WHERE identity_id = ?').bind(identity.id).first(),
  ]);
  return {
    id: identity.id,
    slot,
    name: identity.name,
    voltageV: identity.voltage_v,
    capacityAh: identity.capacity_mah / 1000,
    fullVoltageV: identity.full_voltage_v ?? null,
    active: identity.active,
    cycles: cycle?.cycles ?? 0,
    loggedCycles: cycleTotal?.n ?? 0,
    soh: cycle?.soh_reported ?? last?.soh ?? null,
    measuredCapacityAh: cycle?.capacity_ah ?? null,
    lastRecordedMs: last?.timestamp_ms ?? null,
    lastSoc: last?.soc ?? null,
    defaultCapacityAh: number(env?.[`BATTERY${slot}_CAPACITY_AH`]),
  };
}

async function readSession(env) {
  try {
    const db = env.battery_management_db;
    const [session, identities, specs] = await Promise.all([
      getSessionRow(db), getBatteryIdentities(db), getBatterySpecs(db),
    ]);
    const stats = await Promise.all(identities.map((identity) => identityStats(db, identity, env)));
    const byId = Object.fromEntries(stats.map((item) => [item.id, item]));
    const describe = (id) => (id ? byId[id] ?? null : null);
    return json({
      pending: Boolean(session.pending),
      reason: session.reason ?? null,
      sinceReadingId: session.since_reading_id ?? null,
      gapStartedMs: session.gap_started_ms ?? null,
      resumedMs: session.resumed_ms ?? null,
      gapSeconds: session.gap_started_ms && session.resumed_ms
        ? Math.round((session.resumed_ms - session.gap_started_ms) / 1000) : null,
      previous: { 1: describe(session.previous_identity1), 2: describe(session.previous_identity2) },
      current: { 1: describe(specs[1]?.identity_id), 2: describe(specs[2]?.identity_id) },
      saved: {
        1: stats.filter((item) => item.slot === 1),
        2: stats.filter((item) => item.slot === 2),
      },
    });
  } catch (error) {
    return json({ error: error.message || 'Could not read the connection state' }, 500);
  }
}

function specStatement(db, slot, identity) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO battery_specs (slot, name, voltage_v, capacity_mah, updated_at_ms, identity_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET
      name = excluded.name,
      voltage_v = excluded.voltage_v,
      capacity_mah = excluded.capacity_mah,
      updated_at_ms = excluded.updated_at_ms,
      identity_id = excluded.identity_id
  `).bind(slot, identity.name, identity.voltage_v, identity.capacity_mah, now, identity.id);
}

// Re-attribute the readings recorded while the question was open to the chosen battery and recompute
// their SOC from that battery's own last recorded state (or from its rest voltage if it is new).
async function reassignSlot(db, env, slot, identity, sinceReadingId, isNew) {
  const column = `battery${slot}`;
  const capacityAh = identity.capacity_mah / 1000;
  const previousRecord = isNew ? null : await db.prepare(`
    SELECT battery${slot}_soc AS soc, battery${slot}_soh AS soh
    FROM readings
    WHERE battery${slot}_identity_id = ? AND id < ? AND battery${slot}_soc IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).bind(identity.id, sinceReadingId).first();
  const cycle = await latestIdentityCycle(db, identity.id);
  const soh = cycle?.soh_reported ?? previousRecord?.soh ?? null;
  const params = healthParams(env);

  const rows = (await db.prepare(`
    SELECT id, timestamp_ms, ${column}_json AS battery_json
    FROM readings
    WHERE id >= ?
    ORDER BY id ASC
    LIMIT ?
  `).bind(sinceReadingId, RECHAIN_ROW_LIMIT).all()).results;

  await db.prepare(`UPDATE readings SET ${column}_identity_id = ? WHERE id >= ?`).bind(identity.id, sinceReadingId).run();

  let soc = number(previousRecord?.soc);
  let previousTs = null;
  let lastTs = null;
  const statements = [];
  for (const row of rows) {
    const battery = JSON.parse(row.battery_json || '{}');
    const reading = engineReading(battery);
    if (!reading.connected) {
      statements.push(db.prepare(`UPDATE readings SET ${column}_soc = NULL, ${column}_soh = NULL WHERE id = ?`).bind(row.id));
    } else {
      soc = Number.isFinite(reading.reportedSoc) ? clampPercent(reading.reportedSoc) : stepSoc({
        prevSoc: soc,
        dtSeconds: previousTs === null ? 0 : (row.timestamp_ms - previousTs) / 1000,
        voltage: reading.voltage,
        current: reading.current,
        capacityAh,
        fullVoltage: number(identity.full_voltage_v),
      }, params);
      statements.push(db.prepare(`UPDATE readings SET ${column}_soc = ?, ${column}_soh = ? WHERE id = ?`).bind(soc, soh, row.id));
    }
    previousTs = row.timestamp_ms;
    lastTs = row.timestamp_ms;
  }
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }
  await slotStateStatement(db, slot, {
    identityId: identity.id, soc, tsMs: lastTs, connected: lastTs !== null, tracker: null, soh,
  }).run();
  return { rechained: rows.length, truncated: rows.length === RECHAIN_ROW_LIMIT };
}

function validateNewBattery(choice, slot) {
  const name = String(choice.name || '').trim();
  const voltageV = number(choice.voltageV) ?? 12;
  const capacityAh = number(choice.capacityAh);
  if (!name || name.length > 60) return { error: `Slot ${slot}: enter a battery name up to 60 characters` };
  if (voltageV <= 0 || voltageV > 1000) return { error: `Slot ${slot}: voltage must be greater than 0 and at most 1000 V` };
  if (capacityAh === null || capacityAh <= 0 || capacityAh > 1000) {
    return { error: `Slot ${slot}: capacity must be greater than 0 and at most 1000 Ah` };
  }
  return { name, voltageV, capacityMah: capacityAh * 1000 };
}

async function findOrCreateIdentity(db, slot, details) {
  const existing = await db.prepare(`
    SELECT id, slot, name, voltage_v, capacity_mah, created_at_ms, full_voltage_v
    FROM battery_identities
    WHERE slot = ? AND LOWER(name) = LOWER(?)
    ORDER BY id DESC LIMIT 1
  `).bind(slot, details.name).first();
  if (existing) {
    await db.prepare(`UPDATE battery_identities SET voltage_v = ?, capacity_mah = ? WHERE id = ?`)
      .bind(details.voltageV, details.capacityMah, existing.id).run();
    return { identity: { ...existing, voltage_v: details.voltageV, capacity_mah: details.capacityMah }, created: false };
  }
  const result = await db.prepare(`
    INSERT INTO battery_identities (slot, name, voltage_v, capacity_mah, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).bind(slot, details.name, details.voltageV, details.capacityMah, Date.now()).run();
  return {
    identity: {
      id: result.meta.last_row_id, slot, name: details.name, voltage_v: details.voltageV,
      capacity_mah: details.capacityMah, created_at_ms: Date.now(), full_voltage_v: null,
    },
    created: true,
  };
}

async function getIdentity(db, id) {
  return db.prepare(`
    SELECT id, slot, name, voltage_v, capacity_mah, created_at_ms, full_voltage_v
    FROM battery_identities WHERE id = ?
  `).bind(id).first();
}

// POST /api/session/resolve
// body: { slots: { 1: { action: 'same' | 'saved' | 'new', identityId?, name?, capacityAh?, voltageV? }, 2: {...} } }
async function resolveSession(request, env) {
  try {
    const db = env.battery_management_db;
    const session = await getSessionRow(db);
    if (!session.pending) return json({ error: 'No battery confirmation is waiting' }, 409);
    const body = await request.json();
    const specs = await getBatterySpecs(db);
    const changes = {};

    // Validate everything first so a bad answer for slot 2 cannot leave slot 1 half applied.
    for (const slot of [1, 2]) {
      const choice = body?.slots?.[slot] ?? { action: 'same' };
      if (choice.action === 'same') continue;
      if (choice.action === 'saved') {
        const identity = await getIdentity(db, Number(choice.identityId));
        if (!identity || identity.slot !== slot) return json({ error: `Slot ${slot}: choose a battery saved for this slot` }, 400);
        changes[slot] = { identity, isNew: false };
      } else if (choice.action === 'new') {
        const details = validateNewBattery(choice, slot);
        if (details.error) return json({ error: details.error }, 400);
        changes[slot] = { details, isNew: true };
      } else {
        return json({ error: `Slot ${slot}: unknown action` }, 400);
      }
    }

    const applied = {};
    for (const slot of [1, 2]) {
      const change = changes[slot];
      if (!change) continue;
      let identity = change.identity;
      let isNew = change.isNew;
      if (change.isNew) {
        const found = await findOrCreateIdentity(db, slot, change.details);
        identity = found.identity;
        isNew = found.created;
      }
      if (identity.id === (specs[slot]?.identity_id ?? null)) {
        applied[slot] = { name: identity.name, unchanged: true };
        continue;
      }
      await specStatement(db, slot, identity).run();
      const outcome = await reassignSlot(db, env, slot, identity, session.since_reading_id, isNew);
      applied[slot] = { name: identity.name, identityId: identity.id, createdIdentity: isNew, ...outcome };
    }

    await db.prepare(`UPDATE connection_sessions SET pending = 0 WHERE id = 1`).run();
    return json({ success: true, applied });
  } catch (error) {
    return json({ error: error.message || 'Could not apply the battery confirmation' }, 400);
  }
}

// POST /api/batteries/activate { slot, identityId }: put a saved battery back into its slot.
async function activateBattery(request, env) {
  try {
    const db = env.battery_management_db;
    const body = await request.json();
    const slot = Number(body.slot);
    const identity = await getIdentity(db, Number(body.identityId));
    if (![1, 2].includes(slot) || !identity || identity.slot !== slot) {
      return json({ error: 'Choose a battery that was saved for this slot' }, 400);
    }
    await specStatement(db, slot, identity).run();
    return json({ success: true, battery: { slot, name: identity.name, identity_id: identity.id } });
  } catch (error) {
    return json({ error: error.message || 'Could not select the saved battery' }, 400);
  }
}

// ---------------------------------------------------------------------------------------------
// Battery specifications
// ---------------------------------------------------------------------------------------------

async function readBatteries(env) {
  try {
    const db = env.battery_management_db;
    const [batteries, identities] = await Promise.all([getBatterySpecs(db), getBatteryIdentities(db)]);
    const saved = await Promise.all(identities.map((identity) => identityStats(db, identity, env)));
    return json({ batteries: Object.values(batteries), saved });
  } catch (error) {
    return json({ error: error.message || 'Could not read battery specifications' }, 500);
  }
}

async function saveBattery(request, env) {
  try {
    const battery = await request.json();
    const slot = Number(battery.slot);
    const name = String(battery.name || '').trim();
    const voltageV = number(battery.voltageV);
    const capacityMah = number(battery.capacityMah);
    if (![1, 2].includes(slot)) return json({ error: 'Battery slot must be 1 or 2' }, 400);
    if (!name || name.length > 60) return json({ error: 'Enter a name up to 60 characters' }, 400);
    if (voltageV === null || voltageV <= 0 || voltageV > 1000) return json({ error: 'Voltage must be greater than 0 and at most 1000 V' }, 400);
    if (capacityMah === null || capacityMah <= 0 || capacityMah > 1000000) return json({ error: 'Capacity must be greater than 0 and at most 1,000,000 mAh' }, 400);

    const db = env.battery_management_db;
    const currentBattery = (await getBatterySpecs(db))[slot];
    let identityId = currentBattery?.identity_id;
    let createdIdentity = false;
    let switchedToSaved = false;
    let capacityChanged = false;

    if (currentBattery && identityId && currentBattery.name === name) {
      capacityChanged = Math.abs(currentBattery.capacity_mah - capacityMah) > 1e-6;
      await db.prepare(`
        UPDATE battery_identities
        SET voltage_v = ?, capacity_mah = ?
        WHERE id = ?
      `).bind(voltageV, capacityMah, identityId).run();
    } else {
      // A name that is already saved for this slot brings that battery's history back instead of
      // starting a new one; only an unseen name creates a new battery identity.
      const found = await findOrCreateIdentity(db, slot, { name, voltageV, capacityMah });
      identityId = found.identity.id;
      createdIdentity = found.created;
      switchedToSaved = !found.created;
    }

    await db.prepare(`
      INSERT INTO battery_specs (slot, name, voltage_v, capacity_mah, updated_at_ms, identity_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET
        name = excluded.name,
        voltage_v = excluded.voltage_v,
        capacity_mah = excluded.capacity_mah,
        updated_at_ms = excluded.updated_at_ms,
        identity_id = excluded.identity_id
    `).bind(slot, name, voltageV, capacityMah, Date.now(), identityId).run();

    return json({
      success: true,
      createdIdentity,
      switchedToSaved,
      capacityChanged,
      battery: { slot, name, voltage_v: voltageV, capacity_mah: capacityMah, identity_id: identityId },
    });
  } catch (error) {
    return json({ error: error.message || 'Could not save battery specifications' }, 400);
  }
}

async function deleteBattery(request, env, slot) {
  try {
    if (![1, 2].includes(slot)) return json({ error: 'Battery slot must be 1 or 2' }, 400);
    const battery = (await getBatterySpecs(env.battery_management_db))[slot];
    if (!battery) return json({ error: 'Battery record not found' }, 404);

    const body = await request.json();
    if (body.confirmName !== battery.name) {
      return json({ error: `Type "${battery.name}" exactly to confirm deletion` }, 400);
    }

    await env.battery_management_db.prepare('DELETE FROM battery_specs WHERE slot = ?').bind(slot).run();
    return json({ success: true, deletedBattery: battery.name, readingsDeleted: false });
  } catch (error) {
    return json({ error: error.message || 'Could not delete battery specifications' }, 500);
  }
}

// ---------------------------------------------------------------------------------------------
// History (Database reader)
// ---------------------------------------------------------------------------------------------

function fillGaps(points, bucketMs, keys) {
  const filled = [];
  for (let index = 0; index < points.length; index += 1) {
    if (index > 0 && points[index].timestamp_ms - points[index - 1].timestamp_ms > bucketMs * 3) {
      filled.push({
        timestamp_ms: points[index - 1].timestamp_ms + bucketMs,
        ...Object.fromEntries(keys.map((key) => [key, null])),
      });
    }
    filled.push(points[index]);
  }
  return filled;
}

async function readBatteryIdentityHistory(db, identity, startMs, endMs, bucketMs) {
  if (!identity) return { series: [], latest: null };
  const slot = identity.slot;
  const identityColumn = `battery${slot}_identity_id`;
  const batteryColumn = `battery${slot}_json`;
  const socColumn = `battery${slot}_soc`;
  const sohColumn = `battery${slot}_soh`;
  const [seriesResult, latest] = await Promise.all([
    db.prepare(`
      SELECT CAST(timestamp_ms / ? AS INTEGER) * ? AS timestamp_ms,
             AVG(json_extract(${batteryColumn}, '$.power')) AS power,
             AVG(json_extract(${batteryColumn}, '$.current')) AS current,
             AVG(json_extract(${batteryColumn}, '$.voltage')) AS voltage,
             AVG(json_extract(${batteryColumn}, '$.temperature')) AS temperature,
             AVG(${socColumn}) AS soc,
             AVG(${sohColumn}) AS soh
      FROM readings
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? AND ${identityColumn} = ?
      GROUP BY CAST(timestamp_ms / ? AS INTEGER)
      ORDER BY timestamp_ms ASC
    `).bind(bucketMs, bucketMs, startMs, endMs, identity.id, bucketMs).all(),
    db.prepare(`
      SELECT timestamp_ms, mode, ${batteryColumn} AS battery_json,
             ${socColumn} AS battery_soc, ${sohColumn} AS battery_soh
      FROM readings
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? AND ${identityColumn} = ?
      ORDER BY timestamp_ms DESC
      LIMIT 1
    `).bind(startMs, endMs, identity.id).first(),
  ]);
  const series = seriesResult.results.map((point) => ({
    timestamp_ms: Number(point.timestamp_ms),
    power: number(point.power),
    current: number(point.current),
    voltage: number(point.voltage),
    temperature: number(point.temperature),
    soc: number(point.soc),
    soh: number(point.soh),
  }));
  return {
    series: fillGaps(series, bucketMs, ['power', 'current', 'voltage', 'temperature', 'soc', 'soh']),
    latest: latest ? {
      timestamp: latest.timestamp_ms,
      mode: latest.mode,
      ...batteryWithHealth(latest.battery_json, latest.battery_soc, latest.battery_soh),
    } : null,
  };
}

const HISTORY_RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
};

async function readHistory(request, env) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const range = resolveRange(searchParams, HISTORY_RANGES, '24h');
    const requestedTableSlot = searchParams.get('slot') === '2' ? 2 : 1;
    const db = env.battery_management_db;
    const identities = await getBatteryIdentities(db);
    const activeIdentity = (slot) => identities.find((identity) => identity.active && identity.slot === slot);
    const chooseIdentity = (parameter, slot) => {
      const requestedId = Number(searchParams.get(parameter));
      return identities.find((identity) => identity.id === requestedId) || activeIdentity(slot) || null;
    };
    const leftIdentity = chooseIdentity('leftBatteryId', 1);
    const rightIdentity = chooseIdentity('rightBatteryId', 2);
    const requestedTableBatteryId = Number(searchParams.get('batteryId'));
    const tableIdentity = identities.find((identity) => identity.id === requestedTableBatteryId)
      || activeIdentity(requestedTableSlot)
      || identities[0]
      || null;
    const tableSlot = tableIdentity?.slot ?? requestedTableSlot;
    const tableIdentityFilter = tableIdentity ? ` AND battery${tableSlot}_identity_id = ?` : '';
    const sortBy = ['latest', 'voltage', 'current', 'power', 'temperature', 'soc', 'soh']
      .includes(searchParams.get('sort')) ? searchParams.get('sort') : 'latest';
    const sortOrder = searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
    const sortColumns = {
      latest: 'timestamp_ms',
      voltage: `json_extract(battery${tableSlot}_json, '$.voltage')`,
      current: `json_extract(battery${tableSlot}_json, '$.current')`,
      power: `json_extract(battery${tableSlot}_json, '$.power')`,
      temperature: `json_extract(battery${tableSlot}_json, '$.temperature')`,
      soc: `battery${tableSlot}_soc`,
      soh: `battery${tableSlot}_soh`,
    };
    const bucketMs = Math.max(5000, Math.ceil(range.rangeMs / (1200 * 5000)) * 5000);
    const tableBinds = tableIdentity ? [tableIdentity.id] : [];
    const [countResult, readingsResult, batterySpecs, leftIdentityHistory, rightIdentityHistory] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS samples
        FROM readings
        WHERE timestamp_ms >= ? AND timestamp_ms <= ?${tableIdentityFilter}
      `).bind(range.startMs, range.endMs, ...tableBinds).first(),
      db.prepare(`
         SELECT id, capture_request_id, battery1_identity_id, battery2_identity_id,
           timestamp_ms, mode, switching, wifi_json, system_json,
               battery1_json, battery2_json, battery1_soc, battery2_soc,
               battery1_soh, battery2_soh
        FROM readings
        WHERE timestamp_ms >= ? AND timestamp_ms <= ?${tableIdentityFilter}
        ORDER BY ${sortBy === 'latest'
          ? 'timestamp_ms DESC'
          : `${sortColumns[sortBy]} IS NULL ASC, ${sortColumns[sortBy]} ${sortOrder}`}, timestamp_ms DESC
        LIMIT 100
      `).bind(range.startMs, range.endMs, ...tableBinds).all(),
      getBatterySpecs(db),
      readBatteryIdentityHistory(db, leftIdentity, range.startMs, range.endMs, bucketMs),
      readBatteryIdentityHistory(db, rightIdentity, range.startMs, range.endMs, bucketMs),
    ]);
    const identityNames = Object.fromEntries(identities.map((identity) => [identity.id, identity.name]));
    const readings = readingsResult.results.map((row) => ({
      id: row.id,
      captureRequestId: row.capture_request_id,
      battery1IdentityId: row.battery1_identity_id,
      battery2IdentityId: row.battery2_identity_id,
      timestamp: row.timestamp_ms,
      mode: row.mode,
      switching: Boolean(row.switching),
      wifi: JSON.parse(row.wifi_json || '{}'),
      system: JSON.parse(row.system_json || '{}'),
      battery1: {
        ...batteryWithHealth(row.battery1_json, row.battery1_soc, row.battery1_soh),
        identityId: row.battery1_identity_id,
        identityName: identityNames[row.battery1_identity_id] || '',
      },
      battery2: {
        ...batteryWithHealth(row.battery2_json, row.battery2_soc, row.battery2_soh),
        identityId: row.battery2_identity_id,
        identityName: identityNames[row.battery2_identity_id] || '',
      },
    }));

    return json({
      range: range.key,
      startMs: range.startMs,
      endMs: range.endMs,
      tableSlot,
      tableSort: sortBy,
      tableOrder: sortOrder.toLowerCase(),
      selectedBatteryId: tableIdentity?.id ?? null,
      selectedIdentityIds: {
        left: leftIdentity?.id ?? null,
        right: rightIdentity?.id ?? null,
      },
      identitySeries: {
        left: leftIdentityHistory,
        right: rightIdentityHistory,
      },
      intervalMs: bucketMs,
      sampleCount: countResult?.samples ?? 0,
      readings,
      batteries: Object.values(batterySpecs),
      batteryIdentities: identities,
      googleSheetsConfigured: Boolean(env.GOOGLE_SHEETS_WEBHOOK_URL && env.GOOGLE_SHEETS_SYNC_TOKEN),
    });
  } catch (error) {
    return json({ error: error.message || 'Could not read telemetry history' }, 500);
  }
}

// ---------------------------------------------------------------------------------------------
// CSV export (same columns as the Google Sheet and Dataset 2)
// ---------------------------------------------------------------------------------------------

function csvStream(produceLines, filename) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`${CSV_HEADERS.join(',')}\r\n`));
        for await (const chunk of produceLines()) controller.enqueue(encoder.encode(chunk));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function exportReadingsCsv(request, env) {
  try {
    const db = env.battery_management_db;
    const searchParams = new URL(request.url).searchParams;
    const range = resolveRange(searchParams, HISTORY_RANGES, '24h');
    const identities = await getBatteryIdentities(db);
    const identityNames = Object.fromEntries(identities.map((identity) => [identity.id, identity.name]));
    const selected = identities.find((identity) => identity.id === Number(searchParams.get('batteryId')));
    const filter = selected ? ` AND battery${selected.slot}_identity_id = ?` : '';
    const timeZone = env.CSV_TIME_ZONE || 'Asia/Manila';
    const filename = `battery-readings${selected ? `-${selected.name.replace(/[^\w.-]+/g, '_')}` : ''}.csv`;

    return csvStream(async function* produce() {
      let lastId = 0;
      for (;;) {
        const { results } = await db.prepare(`
          SELECT id, capture_request_id, battery1_identity_id, battery2_identity_id,
                 timestamp_ms, mode, switching, wifi_json, system_json,
                 battery1_json, battery2_json, battery1_soc, battery2_soc, battery1_soh, battery2_soh
          FROM readings
          WHERE id > ? AND timestamp_ms >= ? AND timestamp_ms <= ?${filter}
          ORDER BY id ASC
          LIMIT 2000
        `).bind(lastId, range.startMs, range.endMs, ...(selected ? [selected.id] : [])).all();
        if (results.length === 0) return;
        yield `${results.map((row) => readingToCsvLine({
          id: row.id,
          timestamp_ms: row.timestamp_ms,
          mode: row.mode,
          switching: Boolean(row.switching),
          wifi: JSON.parse(row.wifi_json || '{}'),
          system: JSON.parse(row.system_json || '{}'),
          captureRequestId: row.capture_request_id,
          battery1: {
            ...batteryWithHealth(row.battery1_json, row.battery1_soc, row.battery1_soh),
            identityId: row.battery1_identity_id, identityName: identityNames[row.battery1_identity_id] || '',
          },
          battery2: {
            ...batteryWithHealth(row.battery2_json, row.battery2_soc, row.battery2_soh),
            identityId: row.battery2_identity_id, identityName: identityNames[row.battery2_identity_id] || '',
          },
        }, timeZone)).join('\r\n')}\r\n`;
        lastId = results.at(-1).id;
      }
    }, filename);
  } catch (error) {
    return json({ error: error.message || 'Could not export readings' }, 500);
  }
}

// ---------------------------------------------------------------------------------------------
// Analytics + SOH forecast
// ---------------------------------------------------------------------------------------------

const MIN_RELIABLE_SOC_DECLINE_PERCENT = 0.1;
const MIN_DISCHARGE_CURRENT_A = 0.02;

// Battery 1 powers the ESP32 in every mode, so it discharges whenever its net current is negative,
// including while it is the "charging" battery. Battery 2 only discharges while Battery 1 charges.
// Discharge is therefore detected from the sign of the measured net current, never from the mode.
function batteryAnalytics(series, index, capacityAh) {
  const batteryKey = `battery${index}`;
  let dischargeHours = 0;
  let dischargedAmpHours = 0;
  let socDeclinePercent = 0;

  for (let pointIndex = 1; pointIndex < series.length; pointIndex += 1) {
    const previous = series[pointIndex - 1];
    const current = series[pointIndex];
    const elapsedHours = (current.timestamp_ms - previous.timestamp_ms) / 3600000;
    const previousNet = previous[`${batteryKey}NetCurrentA`];
    const currentNet = current[`${batteryKey}NetCurrentA`];
    if (
      previous[`${batteryKey}Connected`] !== true
      || current[`${batteryKey}Connected`] !== true
      || !Number.isFinite(previous[`${batteryKey}Soc`])
      || !Number.isFinite(current[`${batteryKey}Soc`])
      || !Number.isFinite(previousNet)
      || !Number.isFinite(currentNet)
      || isRestMode(previous.mode)
      || isRestMode(current.mode)
      || elapsedHours <= 0
      || elapsedHours > (current.intervalMs * 3) / 3600000
    ) continue;

    // Both ends must be discharging: an interval that straddles a charge -> discharge change is
    // skipped instead of being counted as a whole interval of discharge.
    if (previousNet > -MIN_DISCHARGE_CURRENT_A || currentNet > -MIN_DISCHARGE_CURRENT_A) continue;
    const averageNet = (previousNet + currentNet) / 2;

    dischargeHours += elapsedHours;
    dischargedAmpHours += -averageNet * elapsedHours;
    socDeclinePercent += Math.max(0, previous[`${batteryKey}Soc`] - current[`${batteryKey}Soc`]);
  }

  const averageDischargeA = dischargeHours > 0 ? dischargedAmpHours / dischargeHours : null;
  const drainFromSoc = dischargeHours > 0 && socDeclinePercent >= MIN_RELIABLE_SOC_DECLINE_PERCENT
    ? socDeclinePercent / dischargeHours : null;
  const drainFromCurrent = averageDischargeA !== null && capacityAh > 0
    ? (averageDischargeA / capacityAh) * 100 : null;
  const drainPercentPerHour = drainFromSoc ?? drainFromCurrent;
  const latestSample = [...series].reverse().find((point) => (
    point[`${batteryKey}Connected`] === true
    && Number.isFinite(point[`${batteryKey}Soc`])
  ));

  return {
    averageDischargeA,
    dischargeHours,
    drainPercentPerHour,
    drainSource: drainFromSoc !== null ? 'soc' : drainFromCurrent !== null ? 'current' : null,
    minutesPerPercentDrop: drainPercentPerHour > 0 ? 60 / drainPercentPerHour : null,
    socObservationHours: dischargeHours,
    socDeclinePercent,
    latestSoc: latestSample?.[`${batteryKey}Soc`] ?? null,
    hoursToEmpty: drainPercentPerHour > 0 && latestSample ? latestSample[`${batteryKey}Soc`] / drainPercentPerHour : null,
  };
}

// Completed cycles carry exact hours / Ah / depth-of-discharge, so when the period contains any they
// give a truer discharge rate than the sparse samples between them.
function withCycleRates(base, cycles, range) {
  const inRange = cycles.filter((cycle) => cycle.ended_at_ms >= range.startMs && cycle.ended_at_ms <= range.endMs);
  const hours = inRange.reduce((total, cycle) => total + cycle.hours, 0);
  if (inRange.length === 0 || hours <= 0) return base;
  const ah = inRange.reduce((total, cycle) => total + cycle.discharged_ah, 0);
  const dod = inRange.reduce((total, cycle) => total + cycle.dod_percent, 0);
  const drain = dod / hours;
  return {
    ...base,
    averageDischargeA: ah / hours,
    dischargeHours: hours,
    drainPercentPerHour: drain,
    drainSource: 'cycles',
    minutesPerPercentDrop: drain > 0 ? 60 / drain : null,
    socObservationHours: hours,
    socDeclinePercent: dod,
    hoursToEmpty: drain > 0 && Number.isFinite(base.latestSoc) ? base.latestSoc / drain : base.hoursToEmpty,
  };
}

async function loadCycles(db, identityId, limit = 5000) {
  const { results } = await db.prepare(`
    SELECT id, cycle_number, started_at_ms, ended_at_ms, hours, avg_load_a, discharged_ah,
           soc_start, soc_final, soc_final_source, dod_percent, capacity_ah, soh_raw, soh_reported
    FROM battery_cycles
    WHERE identity_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).bind(identityId, limit).all();
  return results.reverse();
}

function forecastFromCycles(cycles) {
  return buildForecast(cycles
    .filter((cycle) => cycle.soh_reported !== null && cycle.soh_raw !== null)
    .map((cycle, index) => ({
      cycle: cycle.cycle_number ?? index + 1,
      sohRaw: cycle.soh_raw,
      sohReported: cycle.soh_reported,
      endedMs: cycle.ended_at_ms,
    })));
}

async function readBatteryIdentityAnalytics(db, identity, range, bucketMs, bucketCount) {
  if (!identity) return null;
  const slot = identity.slot;
  const batteryColumn = `battery${slot}_json`;
  const identityColumn = `battery${slot}_identity_id`;
  const identityTimestampIndex = `readings_battery${slot}_timestamp_idx`;
  const socColumn = `battery${slot}_soc`;
  const result = await db.prepare(`
    WITH RECURSIVE buckets(bucket) AS (
      SELECT 0
      UNION ALL
      SELECT bucket + 1 FROM buckets WHERE bucket + 1 < ?
    ),
    sampled AS (
      SELECT bucket,
             (
               SELECT id
               FROM readings INDEXED BY ${identityTimestampIndex}
               WHERE ${identityColumn} = ?
                 AND timestamp_ms >= ? + buckets.bucket * ?
                 AND timestamp_ms < ? + (buckets.bucket + 1) * ?
               ORDER BY timestamp_ms DESC, id DESC
               LIMIT 1
             ) AS reading_id
      FROM buckets
    )
    SELECT readings.timestamp_ms,
           readings.mode,
           CASE WHEN json_extract(readings.${batteryColumn}, '$.connected') = 1
             THEN CAST(json_extract(readings.${batteryColumn}, '$.current') AS REAL) END AS net_current_a,
           CASE WHEN json_extract(readings.${batteryColumn}, '$.connected') = 1
             THEN readings.${socColumn} END AS soc,
           json_extract(readings.${batteryColumn}, '$.connected') AS connected
    FROM sampled
    JOIN readings ON readings.id = sampled.reading_id
    ORDER BY sampled.bucket ASC
  `).bind(bucketCount, identity.id, range.startMs, bucketMs, range.startMs, bucketMs).all();
  const series = result.results.map((point) => ({
    timestamp_ms: Number(point.timestamp_ms),
    mode: point.mode,
    [`battery${slot}NetCurrentA`]: number(point.net_current_a),
    [`battery${slot}Soc`]: number(point.soc),
    [`battery${slot}Connected`]: point.connected === 1,
    intervalMs: bucketMs,
  }));
  const ratedCapacityAh = identity.capacity_mah / 1000;
  const cycles = await loadCycles(db, identity.id);
  const forecast = forecastFromCycles(cycles);
  const cycleInfo = await latestIdentityCycle(db, identity.id);

  const chartSeries = fillGaps(series.map((point) => ({
    timestamp_ms: point.timestamp_ms,
    mode: point.mode,
    [`battery${slot}Soc`]: point[`battery${slot}Connected`] ? point[`battery${slot}Soc`] : null,
    [`battery${slot}DischargeA`]: point[`battery${slot}Connected`] && point[`battery${slot}NetCurrentA`] < 0
      ? -point[`battery${slot}NetCurrentA`] : null,
  })), bucketMs, [`battery${slot}Soc`, `battery${slot}DischargeA`]);

  return {
    identityId: identity.id,
    slot,
    name: identity.name,
    ratedCapacityAh,
    measuredCapacityAh: cycleInfo?.capacity_ah ?? null,
    sampleCount: series.length,
    series: chartSeries,
    analytics: {
      ...withCycleRates(batteryAnalytics(series, slot, ratedCapacityAh), cycles, range),
      completedCycles: cycleInfo?.cycles ?? 0,
      loggedCycles: cycles.length,
      latestSoh: cycleInfo?.soh_reported ?? null,
      lastCycleAtMs: cycleInfo?.ended_at_ms ?? null,
    },
    forecast,
    cycles: cycles.slice(-30).map((cycle) => ({
      number: cycle.cycle_number,
      startedAtMs: cycle.started_at_ms,
      endedAtMs: cycle.ended_at_ms,
      hours: cycle.hours,
      avgLoadA: cycle.avg_load_a,
      dodPercent: cycle.dod_percent,
      socFinal: cycle.soc_final,
      source: cycle.soc_final_source,
      capacityAh: cycle.capacity_ah,
      sohRaw: cycle.soh_raw,
      sohReported: cycle.soh_reported,
    })),
  };
}

async function createReadingCapture(env) {
  try {
    const result = await env.battery_management_db.prepare(`
      INSERT INTO reading_capture_requests (requested_at_ms, status)
      VALUES (?, 'pending')
    `).bind(Date.now()).run();
    return json({ success: true, captureRequestId: result.meta.last_row_id, waitingForSystem: true });
  } catch (error) {
    return json({ error: error.message || 'Could not request a new reading' }, 500);
  }
}

const ANALYTICS_RANGES = {
  '1h': 60 * 60 * 1000,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

async function readAnalytics(request, env) {
  try {
    const db = env.battery_management_db;
    const searchParams = new URL(request.url).searchParams;
    const range = resolveRange(searchParams, ANALYTICS_RANGES, '1h');
    const bucketCount = Math.min(600, Math.max(1, Math.ceil(range.rangeMs / 60000)));
    const bucketMs = Math.ceil(range.rangeMs / bucketCount);
    const identities = await getBatteryIdentities(db);
    const chooseIdentity = (parameter, slot) => {
      const requestedId = Number(searchParams.get(parameter));
      return identities.find((identity) => identity.id === requestedId)
        || identities.find((identity) => identity.active && identity.slot === slot)
        || null;
    };
    const leftIdentity = chooseIdentity('leftBatteryId', 1);
    const rightIdentity = chooseIdentity('rightBatteryId', 2);
    const leftPromise = readBatteryIdentityAnalytics(db, leftIdentity, range, bucketMs, bucketCount);
    const rightPromise = rightIdentity?.id === leftIdentity?.id
      ? leftPromise
      : readBatteryIdentityAnalytics(db, rightIdentity, range, bucketMs, bucketCount);
    const [left, right] = await Promise.all([leftPromise, rightPromise]);

    return json({
      range: range.key,
      startMs: range.startMs,
      endMs: range.endMs,
      days: range.rangeMs / DAY_MS,
      bucketMs,
      batteryIdentities: identities,
      selectedIdentityIds: {
        left: leftIdentity?.id ?? null,
        right: rightIdentity?.id ?? null,
      },
      sampleCount: Math.max(left?.sampleCount ?? 0, right?.sampleCount ?? 0),
      comparisons: { left, right },
    });
  } catch (error) {
    return json({ error: error.message || 'Could not calculate battery analytics' }, 500);
  }
}

// GET /api/forecast?batteryId=ID  (all stored cycles of that saved battery, independent of any date range)
async function readForecast(request, env) {
  try {
    const db = env.battery_management_db;
    const identities = await getBatteryIdentities(db);
    const requested = Number(new URL(request.url).searchParams.get('batteryId'));
    const identity = identities.find((item) => item.id === requested)
      || identities.find((item) => item.active && item.slot === 1)
      || identities[0] || null;
    if (!identity) return json({ batteryIdentities: identities, identity: null, forecast: buildForecast([]), cycles: [] });
    const cycles = await loadCycles(db, identity.id);
    return json({
      batteryIdentities: identities,
      identity: { id: identity.id, slot: identity.slot, name: identity.name, ratedCapacityAh: identity.capacity_mah / 1000 },
      forecast: forecastFromCycles(cycles),
      cycles,
    });
  } catch (error) {
    return json({ error: error.message || 'Could not calculate the SOH forecast' }, 500);
  }
}

async function exportCyclesCsv(request, env) {
  try {
    const db = env.battery_management_db;
    const identities = await getBatteryIdentities(db);
    const identity = identities.find((item) => item.id === Number(new URL(request.url).searchParams.get('batteryId')));
    if (!identity) return json({ error: 'Choose a saved battery' }, 400);
    const cycles = await loadCycles(db, identity.id, 100000);
    const timeZone = env.CSV_TIME_ZONE || 'Asia/Manila';
    const head = 'Battery,Cycle,Started,Ended,Hours,Average load (A),Discharged (Ah),SOC start (%),SOC final (%),SOC final source,Depth of discharge (%),Capacity (Ah),SOH raw (%),SOH reported (%)';
    const lines = cycles.map((cycle) => [
      `"${identity.name.replace(/"/g, '""')}"`, cycle.cycle_number ?? '',
      formatTimestamp(cycle.started_at_ms, timeZone), formatTimestamp(cycle.ended_at_ms, timeZone),
      cycle.hours.toFixed(4), cycle.avg_load_a.toFixed(4), cycle.discharged_ah.toFixed(4),
      cycle.soc_start.toFixed(3), cycle.soc_final.toFixed(3), cycle.soc_final_source, cycle.dod_percent.toFixed(3),
      cycle.capacity_ah?.toFixed(4) ?? '', cycle.soh_raw?.toFixed(4) ?? '', cycle.soh_reported?.toFixed(4) ?? '',
    ].join(','));
    return new Response(`${head}\r\n${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="cycles-${identity.name.replace(/[^\w.-]+/g, '_')}.csv"`,
      },
    });
  } catch (error) {
    return json({ error: error.message || 'Could not export cycles' }, 500);
  }
}

async function syncGoogleSheets(env) {
  const webhookUrl = env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();
  const syncToken = env.GOOGLE_SHEETS_SYNC_TOKEN?.trim();
  if (!webhookUrl || !syncToken) return;

  const db = env.battery_management_db;
  try {
    await db.prepare(`
      INSERT OR IGNORE INTO integration_cursors (name, last_reading_id)
      VALUES ('google_sheets', 0)
    `).run();
    const cursor = await db.prepare(`
      SELECT last_reading_id FROM integration_cursors WHERE name = 'google_sheets'
    `).first();
    const result = await db.prepare(`
            SELECT id, capture_request_id, battery1_identity_id, battery2_identity_id,
              timestamp_ms, mode, switching, wifi_json, system_json,
             battery1_json, battery2_json, battery1_soc, battery2_soc,
             battery1_soh, battery2_soh
      FROM readings
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 500
    `).bind(cursor.last_reading_id).all();
    if (!result.results.length) return;

    const identities = await getBatteryIdentities(db);
    const identityNames = Object.fromEntries(identities.map((identity) => [identity.id, identity.name]));
    const readings = result.results.map((row) => ({
      id: row.id,
      captureRequestId: row.capture_request_id,
      timestampMs: row.timestamp_ms,
      mode: row.mode,
      switching: Boolean(row.switching),
      wifi: JSON.parse(row.wifi_json || '{}'),
      system: JSON.parse(row.system_json || '{}'),
      battery1: {
        ...batteryWithHealth(row.battery1_json, row.battery1_soc, row.battery1_soh),
        identityId: row.battery1_identity_id,
        identityName: identityNames[row.battery1_identity_id] || '',
      },
      battery2: {
        ...batteryWithHealth(row.battery2_json, row.battery2_soc, row.battery2_soh),
        identityId: row.battery2_identity_id,
        identityName: identityNames[row.battery2_identity_id] || '',
      },
    }));
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: syncToken, readings }),
    });
    const responseBody = await response.json();
    if (!response.ok || responseBody.success !== true) {
      throw new Error(responseBody.error || `Google Sheets webhook returned HTTP ${response.status}`);
    }

    const lastReadingId = result.results.at(-1).id;
    await db.prepare(`
      UPDATE integration_cursors
      SET last_reading_id = ?
      WHERE name = 'google_sheets' AND last_reading_id = ?
    `).bind(lastReadingId, cursor.last_reading_id).run();
    console.log(JSON.stringify({ event: 'google_sheets_sync', count: readings.length, lastReadingId }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'google_sheets_sync_failed',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function authorizeDevice(request, env) {
  const token = env.DEVICE_TOKEN?.trim();
  if (!token) return json({ error: 'DEVICE_TOKEN is not configured' }, 503);
  if (request.headers.get('Authorization') !== `Bearer ${token}`) {
    return json({ error: 'Unauthorized device' }, 401);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Telemetry from the ESP32
// ---------------------------------------------------------------------------------------------

async function receiveTelemetry(request, env) {
  const unauthorized = authorizeDevice(request, env);
  if (unauthorized) return unauthorized;

  try {
    const data = await request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return json({ error: 'Telemetry must be a JSON object' }, 400);
    }

    const db = env.battery_management_db;
    const timestampMs = Date.now();
    const [previous, batterySpecs, identities, session, pendingCapture] = await Promise.all([
      getLatestReading(db),
      getBatterySpecs(db),
      getBatteryIdentities(db),
      getSessionRow(db),
      db.prepare(`
        SELECT id
        FROM reading_capture_requests
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `).first(),
    ]);
    const battery1 = normalizeBattery(data.battery1);
    const battery2 = normalizeBattery(data.battery2);
    const system = data.system && typeof data.system === 'object' ? data.system : {};
    const wifi = data.wifi && typeof data.wifi === 'object' ? data.wifi : {};
    const mode = data.mode ?? null;
    const captureRequestId = String(mode || '').trim().toUpperCase() !== 'SYSTEM OFF'
      ? pendingCapture?.id ?? null
      : null;
    const params = healthParams(env);

    const { state, soh: sohBySlot, known } = await loadEngineState(db, env, batterySpecs, identities, Boolean(previous));
    const input = {
      tsMs: timestampMs,
      mode: mode ?? '',
      slots: { 1: engineReading(battery1), 2: engineReading(battery2) },
    };

    // Did the connection stop and come back (long gap, or a sensor that was missing is back)?
    const reconnectGapMs = (number(env.RECONNECT_GAP_SECONDS) ?? DEFAULT_RECONNECT_GAP_SECONDS) * 1000;
    const resumedAfterGap = Boolean(previous) && timestampMs - previous.timestamp_ms > reconnectGapMs;
    const sensorBack = [1, 2].some((slot) => known[slot] && !state.slots[slot].connected && input.slots[slot].connected);
    const startsQuestion = Boolean(previous) && !session.pending && (resumedAfterGap || sensorBack);
    const frozen = Boolean(session.pending) || startsQuestion;

    const outcome = processTelemetry(state, input, params, { freeze: frozen });

    // Score the discharge cycles that finished on this reading.
    const cycleRows = [];
    for (const cycle of outcome.finishedCycles) {
      const identityId = batterySpecs[cycle.slot]?.identity_id ?? null;
      if (!identityId) continue;
      const context = await scoringContext(db, identityId);
      const score = scoreCycle(cycle, context, params);
      cycleRows.push({ cycle, identityId, score, number: score.usable ? context.usableCount + 1 : null });
      if (score.usable) sohBySlot[cycle.slot] = score.sohReported;
    }

    const soc = {};
    const soh = {};
    for (const slot of [1, 2]) {
      const update = outcome.slots[slot];
      const battery = slot === 1 ? battery1 : battery2;
      soc[slot] = update.soc;
      soh[slot] = update.connected ? (reportedSohFrom(battery) ?? sohBySlot[slot] ?? null) : null;
    }

    const result = await db.prepare(`
      INSERT INTO readings (
        timestamp_ms, mode, switching, wifi_json, system_json,
        battery1_json, battery2_json,
        battery1_soc, battery2_soc, battery1_soh, battery2_soh, capture_request_id,
        battery1_identity_id, battery2_identity_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      timestampMs,
      mode,
      data.switching ? 1 : 0,
      JSON.stringify(wifi),
      JSON.stringify(system),
      JSON.stringify(battery1),
      JSON.stringify(battery2),
      soc[1],
      soc[2],
      soh[1],
      soh[2],
      captureRequestId,
      batterySpecs[1]?.identity_id ?? null,
      batterySpecs[2]?.identity_id ?? null,
    ).run();
    const readingId = result.meta.last_row_id;

    const statements = [];
    if (captureRequestId !== null) {
      statements.push(db.prepare(`
        UPDATE reading_capture_requests
        SET status = 'captured', captured_at_ms = ?, reading_id = ?
        WHERE id = ? AND status = 'pending'
      `).bind(timestampMs, readingId, captureRequestId));
    }
    if (startsQuestion) {
      statements.push(db.prepare(`
        UPDATE connection_sessions
        SET pending = 1, since_reading_id = ?, gap_started_ms = ?, resumed_ms = ?,
            previous_identity1 = ?, previous_identity2 = ?, reason = ?
        WHERE id = 1
      `).bind(
        readingId, previous.timestamp_ms, timestampMs,
        batterySpecs[1]?.identity_id ?? null, batterySpecs[2]?.identity_id ?? null,
        resumedAfterGap ? 'gap' : 'sensor',
      ));
    }
    for (const { cycle, identityId, score, number: cycleNumber } of cycleRows) {
      statements.push(db.prepare(`
        INSERT OR IGNORE INTO battery_cycles (
          identity_id, slot, cycle_number, started_at_ms, ended_at_ms, hours, avg_load_a, discharged_ah,
          soc_start, soc_final, soc_final_source, dod_percent, capacity_ah, soh_raw, soh_reported, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        identityId, cycle.slot, cycleNumber, cycle.startedMs, cycle.endedMs, cycle.hours, cycle.avgLoadA,
        cycle.dischargedAh, cycle.socStart, cycle.socFinal, cycle.socFinalSource, cycle.dodPercent,
        cycle.capacityAh, score.usable ? score.sohRaw : null, score.usable ? score.sohReported : null, timestampMs,
      ));
    }
    for (const slot of [1, 2]) {
      const update = outcome.slots[slot];
      const identityId = batterySpecs[slot]?.identity_id ?? null;
      statements.push(slotStateStatement(db, slot, {
        identityId,
        soc: update.soc ?? state.slots[slot].soc,
        tsMs: timestampMs,
        connected: update.connected,
        tracker: update.tracker,
        soh: sohBySlot[slot] ?? null,
      }));
      if (identityId && update.fullVoltageChanged && Number.isFinite(update.fullVoltage)) {
        statements.push(db.prepare('UPDATE battery_identities SET full_voltage_v = ? WHERE id = ?')
          .bind(update.fullVoltage, identityId));
      }
    }
    await db.batch(statements);

    return json({
      success: true,
      receivedAt: timestampMs,
      batteryConfirmationRequired: Boolean(session.pending) || startsQuestion,
    });
  } catch (error) {
    return json({ error: error.message || 'Could not store telemetry' }, 400);
  }
}

async function readEsp32(env) {
  try {
    const [row, batterySpecs, identities] = await Promise.all([
      getLatestReading(env.battery_management_db),
      getBatterySpecs(env.battery_management_db),
      getBatteryIdentities(env.battery_management_db),
    ]);
    if (!row) return json({
      connected: false,
      error: 'Waiting for first ESP32 reading',
      batteries: Object.values(batterySpecs),
    });

    const wifi = JSON.parse(row.wifi_json);
    const system = JSON.parse(row.system_json || '{}');
    const identityNames = Object.fromEntries(identities.map((identity) => [identity.id, identity.name]));
    const isFresh = Date.now() - row.timestamp_ms <= 15000;
    const connected = isFresh && system.wifiConnected !== false;

    return json({
      connected,
      ...(!connected ? { error: isFresh ? 'ESP32 reports Wi-Fi disconnected' : 'ESP32 telemetry is stale' } : {}),
      timestamp: row.timestamp_ms / 1000,
      mode: row.mode,
      switching: Boolean(row.switching),
      system,
      wifi,
      battery1: {
        ...JSON.parse(row.battery1_json),
        identityId: row.battery1_identity_id,
        identityName: identityNames[row.battery1_identity_id] || '',
      },
      battery2: {
        ...JSON.parse(row.battery2_json),
        identityId: row.battery2_identity_id,
        identityName: identityNames[row.battery2_identity_id] || '',
      },
      batteries: Object.values(batterySpecs),
    });
  } catch (error) {
    return json({ connected: false, error: error.message }, 500);
  }
}

async function getHealth(env) {
  try {
    const db = env.battery_management_db;
    const [row, batterySpecs] = await Promise.all([
      getLatestReading(db),
      getBatterySpecs(db),
    ]);
    if (!row) {
      return json({
        configured: true,
        battery1: { soc: null, soh: null, ratedCapacityAh: capacityForBattery(env, 1, batterySpecs), error: 'No D1 reading found', source: 'd1' },
        battery2: { soc: null, soh: null, ratedCapacityAh: capacityForBattery(env, 2, batterySpecs), error: 'No D1 reading found', source: 'd1' },
      });
    }
    const [cycle1, cycle2] = await Promise.all([
      batterySpecs[1]?.identity_id ? latestIdentityCycle(db, batterySpecs[1].identity_id) : null,
      batterySpecs[2]?.identity_id ? latestIdentityCycle(db, batterySpecs[2].identity_id) : null,
    ]);

    return json({
      configured: true,
      battery1: healthForBattery(JSON.parse(row.battery1_json), row.battery1_soc, row.battery1_soh, env, 1, batterySpecs, cycle1),
      battery2: healthForBattery(JSON.parse(row.battery2_json), row.battery2_soc, row.battery2_soh, env, 2, batterySpecs, cycle2),
    });
  } catch (error) {
    return json({ configured: true, error: error.message }, 500);
  }
}

async function queueControl(request, env, pathname) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const mode = Number(pathname.slice('/api/control/'.length));
  if (![1, 2, 3].includes(mode)) return json({ success: false, error: 'Invalid mode' }, 400);

  try {
    const result = await env.battery_management_db.prepare(`
      INSERT INTO device_commands (mode, status, created_at_ms)
      VALUES (?, 'pending', ?)
    `).bind(mode, Date.now()).run();

    return json({ success: true, queued: true, commandId: result.meta.last_row_id }, 202);
  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

async function getDeviceCommand(request, env) {
  const unauthorized = authorizeDevice(request, env);
  if (unauthorized) return unauthorized;

  try {
    const now = Date.now();
    const leaseExpiredBefore = now - 15000;
    const command = await env.battery_management_db.prepare(`
      SELECT id, mode FROM device_commands
      WHERE status = 'pending'
         OR (status = 'delivered' AND delivered_at_ms <= ?)
      ORDER BY id
      LIMIT 1
    `).bind(leaseExpiredBefore).first();

    if (!command) return json({ command: null });

    const update = await env.battery_management_db.prepare(`
      UPDATE device_commands
      SET status = 'delivered', delivered_at_ms = ?, attempts = attempts + 1
      WHERE id = ?
        AND (status = 'pending' OR (status = 'delivered' AND delivered_at_ms <= ?))
    `).bind(now, command.id, leaseExpiredBefore).run();

    if (!update.meta.changes) return json({ command: null });
    return json({ command });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

async function acknowledgeDeviceCommand(request, env, commandId) {
  const unauthorized = authorizeDevice(request, env);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    if (!['applied', 'failed'].includes(body.status)) {
      return json({ error: 'status must be applied or failed' }, 400);
    }

    const result = await env.battery_management_db.prepare(`
      UPDATE device_commands
      SET status = ?, acknowledged_at_ms = ?, result = ?
      WHERE id = ? AND status = 'delivered'
    `).bind(
      body.status,
      Date.now(),
      String(body.result || '').slice(0, 500),
      commandId,
    ).run();

    if (!result.meta.changes) return json({ error: 'Command not found or already acknowledged' }, 404);
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/esp32' && request.method === 'GET') return readEsp32(env);
    if (pathname === '/api/readings' && request.method === 'GET') return readHistory(request, env);
    if (pathname === '/api/readings.csv' && request.method === 'GET') return exportReadingsCsv(request, env);
    if (pathname === '/api/cycles.csv' && request.method === 'GET') return exportCyclesCsv(request, env);
    if (pathname === '/api/reading-captures' && request.method === 'POST') return createReadingCapture(env);
    if (pathname === '/api/analytics' && request.method === 'GET') return readAnalytics(request, env);
    if (pathname === '/api/forecast' && request.method === 'GET') return readForecast(request, env);
    if (pathname === '/api/health' && request.method === 'GET') return getHealth(env);
    if (pathname === '/api/session' && request.method === 'GET') return readSession(env);
    if (pathname === '/api/session/resolve' && request.method === 'POST') return resolveSession(request, env);
    if (pathname === '/api/batteries' && request.method === 'GET') return readBatteries(env);
    if (pathname === '/api/batteries' && request.method === 'POST') return saveBattery(request, env);
    if (pathname === '/api/batteries/activate' && request.method === 'POST') return activateBattery(request, env);
    const batteryMatch = pathname.match(/^\/api\/batteries\/(\d+)$/);
    if (batteryMatch && request.method === 'DELETE') return deleteBattery(request, env, Number(batteryMatch[1]));
    if (pathname.startsWith('/api/control/')) return queueControl(request, env, pathname);
    if (pathname === '/api/device/telemetry' && request.method === 'POST') return receiveTelemetry(request, env);
    if (pathname === '/api/device/commands' && request.method === 'GET') return getDeviceCommand(request, env);

    const ackMatch = pathname.match(/^\/api\/device\/commands\/(\d+)\/ack$/);
    if (ackMatch && request.method === 'POST') {
      return acknowledgeDeviceCommand(request, env, Number(ackMatch[1]));
    }

    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncGoogleSheets(env));
  },
};
