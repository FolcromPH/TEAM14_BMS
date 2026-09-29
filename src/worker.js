const BATTERY_FIELDS = [
  'connected', 'voltage', 'current', 'power', 'temperature', 'soc', 'soh', 'status',
  'soc_kalman', 'soc_coulomb', 'soc_ocv', 'soh_pct', 'soh_relative_pct',
  'measuredCapacityAh', 'capacityAh', 'capacity_ah', 'effective_capacity_Ah',
];

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

function estimateSoc(battery, previousSoc, elapsedSeconds, env, index, batterySpecs) {
  const reportedSoc = firstNumber(battery, ['soc_kalman', 'soc_coulomb', 'soc_ocv', 'soc']);
  if (reportedSoc !== null) return clampPercent(reportedSoc);

  const baseSoc = previousSoc ?? number(env.INITIAL_SOC) ?? 100;
  const current = firstNumber(battery, ['current', 'currentA', 'amps']);
  const capacityAh = capacityForBattery(env, index, batterySpecs);
  if (previousSoc === null || current === null || capacityAh <= 0) return clampPercent(baseSoc);

  return clampPercent(baseSoc + (current * elapsedSeconds / 3600 / capacityAh) * 100);
}

function estimateSoh(battery, env, index, batterySpecs) {
  const reportedSoh = firstNumber(battery, ['soh_relative_pct', 'soh_pct', 'soh']);
  if (reportedSoh !== null) return clampPercent(reportedSoh);

  const measuredCapacity = firstNumber(battery, [
    'measuredCapacityAh', 'capacityAh', 'capacity_ah', 'effective_capacity_Ah',
  ]);
  const ratedCapacity = capacityForBattery(env, index, batterySpecs);
  if (measuredCapacity === null || ratedCapacity <= 0) return null;
  return clampPercent(measuredCapacity / ratedCapacity * 100);
}

function healthForBattery(battery, soc, soh, env, index, batterySpecs) {
  const hasSignal = battery.connected === true || Object.entries(battery).some(
    ([field, value]) => field !== 'connected' && value !== null && value !== undefined,
  );
  const capacityAh = firstNumber(battery, [
    'measuredCapacityAh', 'capacityAh', 'capacity_ah', 'effective_capacity_Ah',
  ]);

  return {
    soc: hasSignal ? soc : null,
    soh: hasSignal ? soh : null,
    capacityAh,
    ratedCapacityAh: capacityForBattery(env, index, batterySpecs),
    ...(!hasSignal ? { error: 'Battery not reporting live data' } : {}),
    source: 'd1',
  };
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

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
      SELECT id, slot, name, voltage_v, capacity_mah, created_at_ms
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

async function readBatteryIdentityHistory(db, identity, startMs, bucketMs) {
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
             AVG(${socColumn}) AS soc
      FROM readings
      WHERE timestamp_ms >= ? AND ${identityColumn} = ?
      GROUP BY CAST(timestamp_ms / ? AS INTEGER)
      ORDER BY timestamp_ms ASC
    `).bind(
      bucketMs,
      bucketMs,
      startMs,
      identity.id,
      bucketMs,
    ).all(),
    db.prepare(`
      SELECT timestamp_ms, mode, ${batteryColumn} AS battery_json,
             ${socColumn} AS battery_soc, ${sohColumn} AS battery_soh
      FROM readings
      WHERE timestamp_ms >= ? AND ${identityColumn} = ?
      ORDER BY timestamp_ms DESC
      LIMIT 1
    `).bind(startMs, identity.id).first(),
  ]);
  return {
    series: seriesResult.results.map((point) => ({
      timestamp_ms: Number(point.timestamp_ms),
      power: number(point.power),
      current: number(point.current),
      voltage: number(point.voltage),
      temperature: number(point.temperature),
      soc: number(point.soc),
    })),
    latest: latest ? {
      timestamp: latest.timestamp_ms,
      mode: latest.mode,
      ...batteryWithHealth(latest.battery_json, latest.battery_soc, latest.battery_soh),
    } : null,
  };
}

async function readBatteries(env) {
  try {
    const batteries = await getBatterySpecs(env.battery_management_db);
    return json({ batteries: Object.values(batteries) });
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
    const createdIdentity = !currentBattery || currentBattery.name !== name || !identityId;
    if (createdIdentity) {
      const identity = await db.prepare(`
        INSERT INTO battery_identities (slot, name, voltage_v, capacity_mah, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).bind(slot, name, voltageV, capacityMah, Date.now()).run();
      identityId = identity.meta.last_row_id;
    } else {
      await db.prepare(`
        UPDATE battery_identities
        SET voltage_v = ?, capacity_mah = ?
        WHERE id = ?
      `).bind(voltageV, capacityMah, identityId).run();
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

async function readHistory(request, env) {
  try {
    const ranges = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    };
    const range = new URL(request.url).searchParams.get('range');
    const searchParams = new URL(request.url).searchParams;
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
    const sortBy = ['latest', 'voltage', 'current', 'power', 'temperature', 'soc']
      .includes(searchParams.get('sort')) ? searchParams.get('sort') : 'latest';
    const sortOrder = searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
    const sortColumns = {
      latest: 'timestamp_ms',
      voltage: `json_extract(battery${tableSlot}_json, '$.voltage')`,
      current: `json_extract(battery${tableSlot}_json, '$.current')`,
      power: `json_extract(battery${tableSlot}_json, '$.power')`,
      temperature: `json_extract(battery${tableSlot}_json, '$.temperature')`,
      soc: `battery${tableSlot}_soc`,
    };
    const rangeMs = ranges[range] ?? ranges['24h'];
    const bucketMs = Math.max(5000, Math.ceil(rangeMs / (1200 * 5000)) * 5000);
    const startMs = Date.now() - rangeMs;
    const [seriesResult, readingsResult, batterySpecs, leftIdentityHistory, rightIdentityHistory] = await Promise.all([
      db.prepare(`
        SELECT CAST(timestamp_ms / ? AS INTEGER) * ? AS timestamp_ms,
               COUNT(*) AS samples,
               AVG(json_extract(battery1_json, '$.voltage')) AS battery1Voltage,
               AVG(json_extract(battery1_json, '$.current')) AS battery1Current,
               AVG(json_extract(battery1_json, '$.power')) AS battery1Power,
               AVG(json_extract(battery1_json, '$.temperature')) AS battery1Temperature,
               AVG(battery1_soc) AS battery1Soc,
                 AVG(CASE WHEN json_extract(battery1_json, '$.connected') = 1
                   THEN CAST(json_extract(battery1_json, '$.current') AS REAL) END) AS battery1NetCurrentA,
                 AVG(CASE WHEN json_extract(battery1_json, '$.connected') = 1
                   THEN COALESCE(json_extract(battery1_json, '$.soc_kalman'),
                         json_extract(battery1_json, '$.soc_coulomb'),
                         json_extract(battery1_json, '$.soc_ocv'),
                         json_extract(battery1_json, '$.soc')) END) AS battery1ReportedSoc,
                 MAX(CASE WHEN json_extract(battery1_json, '$.connected') = 1 THEN 1 ELSE 0 END) AS battery1Connected,
               AVG(json_extract(battery2_json, '$.voltage')) AS battery2Voltage,
               AVG(json_extract(battery2_json, '$.current')) AS battery2Current,
               AVG(json_extract(battery2_json, '$.power')) AS battery2Power,
               AVG(json_extract(battery2_json, '$.temperature')) AS battery2Temperature,
                 AVG(battery2_soc) AS battery2Soc,
                 AVG(CASE WHEN json_extract(battery2_json, '$.connected') = 1
                   THEN CAST(json_extract(battery2_json, '$.current') AS REAL) END) AS battery2NetCurrentA,
                 AVG(CASE WHEN json_extract(battery2_json, '$.connected') = 1
                   THEN COALESCE(json_extract(battery2_json, '$.soc_kalman'),
                         json_extract(battery2_json, '$.soc_coulomb'),
                         json_extract(battery2_json, '$.soc_ocv'),
                         json_extract(battery2_json, '$.soc')) END) AS battery2ReportedSoc,
                 MAX(CASE WHEN json_extract(battery2_json, '$.connected') = 1 THEN 1 ELSE 0 END) AS battery2Connected
        FROM readings
        WHERE timestamp_ms >= ?${tableIdentityFilter}
        GROUP BY CAST(timestamp_ms / ? AS INTEGER)
        ORDER BY 1 ASC
      `).bind(
        bucketMs,
        bucketMs,
        startMs,
        ...(tableIdentity ? [tableIdentity.id] : []),
        bucketMs,
      ).all(),
      db.prepare(`
         SELECT id, capture_request_id, battery1_identity_id, battery2_identity_id,
           timestamp_ms, mode, switching, wifi_json, system_json,
               battery1_json, battery2_json, battery1_soc, battery2_soc,
               battery1_soh, battery2_soh
        FROM readings
        WHERE timestamp_ms >= ?${tableIdentityFilter}
        ORDER BY ${sortBy === 'latest'
          ? 'timestamp_ms DESC'
          : `${sortColumns[sortBy]} IS NULL ASC, ${sortColumns[sortBy]} ${sortOrder}`}, timestamp_ms DESC
        LIMIT 100
      `).bind(
        startMs,
        ...(tableIdentity ? [tableIdentity.id] : []),
      ).all(),
      getBatterySpecs(db),
      readBatteryIdentityHistory(db, leftIdentity, startMs, bucketMs),
      readBatteryIdentityHistory(db, rightIdentity, startMs, bucketMs),
    ]);
    const series = seriesResult.results.map((point) => ({
      ...point,
      timestamp_ms: Number(point.timestamp_ms),
      battery1NetCurrentA: number(point.battery1NetCurrentA),
      battery1Soc: number(point.battery1Soc),
      battery1ReportedSoc: number(point.battery1ReportedSoc),
      battery1Connected: point.battery1Connected === 1,
      battery2NetCurrentA: number(point.battery2NetCurrentA),
      battery2Soc: number(point.battery2Soc),
      battery2ReportedSoc: number(point.battery2ReportedSoc),
      battery2Connected: point.battery2Connected === 1,
      intervalMs: bucketMs,
    }));
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
    recalculateSocForCapacity(series, 1, capacityForBattery(env, 1, batterySpecs));
    recalculateSocForCapacity(series, 2, capacityForBattery(env, 2, batterySpecs));

    return json({
      range: range in ranges ? range : '24h',
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
      series,
      readings,
      batteries: Object.values(batterySpecs),
      batteryIdentities: identities,
      googleSheetsConfigured: Boolean(env.GOOGLE_SHEETS_WEBHOOK_URL && env.GOOGLE_SHEETS_SYNC_TOKEN),
    });
  } catch (error) {
    return json({ error: error.message || 'Could not read telemetry history' }, 500);
  }
}

function batteryAnalytics(series, index) {
  const batteryKey = `battery${index}`;
  const dischargeMode = `Battery${index === 1 ? 2 : 1} Charging`;
  const chargeMode = `Battery${index} Charging`;
  let dischargeHours = 0;
  let socObservationHours = 0;
  let netSocChange = 0;
  let dischargedAmpHours = 0;

  for (let pointIndex = 1; pointIndex < series.length; pointIndex += 1) {
    const previous = series[pointIndex - 1];
    const current = series[pointIndex];
    const elapsedHours = (current.timestamp_ms - previous.timestamp_ms) / 3600000;
    if (
      (index !== 1 && (previous.mode !== dischargeMode || current.mode !== dischargeMode))
      || previous[`${batteryKey}Connected`] !== true
      || current[`${batteryKey}Connected`] !== true
      || !Number.isFinite(previous[`${batteryKey}Soc`])
      || !Number.isFinite(current[`${batteryKey}Soc`])
      || elapsedHours <= 0
      || elapsedHours > (current.intervalMs * 3) / 3600000
    ) continue;

    const intervalSocChange = current[`${batteryKey}Soc`] - previous[`${batteryKey}Soc`];
    socObservationHours += elapsedHours;
    netSocChange += intervalSocChange;
    if (intervalSocChange >= 0) continue;

    if (!Number.isFinite(previous[`${batteryKey}CurrentA`])
      || !Number.isFinite(current[`${batteryKey}CurrentA`])) continue;

    dischargeHours += elapsedHours;
    dischargedAmpHours += (
      previous[`${batteryKey}CurrentA`] + current[`${batteryKey}CurrentA`]
    ) / 2 * elapsedHours;
  }

  const averageDischargeA = dischargeHours > 0 ? dischargedAmpHours / dischargeHours : null;
  const drainPercentPerHour = socObservationHours > 0 && netSocChange < 0
    ? -netSocChange / socObservationHours
    : null;
  const latestSample = [...series].reverse().find((point) => (
    point[`${batteryKey}Connected`] === true
    && Number.isFinite(point[`${batteryKey}Soc`])
  ));
  const latestSohSample = [...series].reverse().find((point) => (
    point[`${batteryKey}Connected`] === true
    && Number.isFinite(point[`${batteryKey}Soh`])
  ));
  const hoursToEmpty = drainPercentPerHour > 0 && latestSample
    ? latestSample[`${batteryKey}Soc`] / drainPercentPerHour
    : null;

  const measuredCycleDrops = [];
  let completedChargeCycles = 0;
  let cycle = null;
  for (let pointIndex = 0; pointIndex < series.length; pointIndex += 1) {
    const point = series[pointIndex];
    if (point.mode === chargeMode) {
      if (!cycle) {
        cycle = {
          startMs: point.timestamp_ms,
          endMs: point.timestamp_ms,
          startSoh: point[`${batteryKey}Soh`],
          endSoh: point[`${batteryKey}Soh`],
          sohSampleCount: point[`${batteryKey}Soh`] === null ? 0 : 1,
          startedInRange: pointIndex > 0 && series[pointIndex - 1].mode !== chargeMode,
          startSoc: point[`${batteryKey}Soc`],
          endSoc: point[`${batteryKey}Soc`],
        };
      } else {
        cycle.endMs = point.timestamp_ms;
        if (point[`${batteryKey}Soh`] !== null) {
          if (cycle.sohSampleCount === 0) cycle.startSoh = point[`${batteryKey}Soh`];
          cycle.endSoh = point[`${batteryKey}Soh`];
          cycle.sohSampleCount += 1;
        }
        cycle.endSoc = point[`${batteryKey}Soc`] ?? cycle.endSoc;
      }
    } else if (cycle) {
      if (cycle.startedInRange) completedChargeCycles += 1;
      if (cycle.startedInRange && cycle.sohSampleCount >= 2
        && cycle.startSoh !== null && cycle.startSoh !== undefined
        && cycle.endSoh !== null && cycle.endSoh !== undefined) {
        measuredCycleDrops.push(Math.max(0, cycle.startSoh - cycle.endSoh));
      }
      cycle = null;
    }
  }

  const sohDropPerCycle = measuredCycleDrops.length > 0
    ? measuredCycleDrops.reduce((total, drop) => total + drop, 0) / measuredCycleDrops.length
    : null;

  return {
    averageDischargeA,
    drainPercentPerHour,
    minutesPerPercentDrop: drainPercentPerHour > 0 ? 60 / drainPercentPerHour : null,
    socObservationHours,
    latestSoc: latestSample?.[`${batteryKey}Soc`] ?? null,
    latestSoh: latestSohSample?.[`${batteryKey}Soh`] ?? null,
    hoursToEmpty,
    completedChargeCycles,
    measuredSohCycleCount: measuredCycleDrops.length,
    predictedSohDropNextCycle: sohDropPerCycle,
    sohForecastConfidence: measuredCycleDrops.length >= 5
      ? 'higher'
      : measuredCycleDrops.length >= 2
        ? 'limited'
        : measuredCycleDrops.length === 1
          ? 'very limited'
          : 'unavailable',
  };
}

function recalculateSocForCapacity(series, index, capacityAh) {
  const socKey = `battery${index}Soc`;
  const reportedSocKey = `battery${index}ReportedSoc`;
  const currentKey = `battery${index}NetCurrentA`;
  const connectedKey = `battery${index}Connected`;
  let previousSoc = null;
  let previousTimestamp = null;

  for (const point of series) {
    if (!point[connectedKey]) {
      point[socKey] = null;
      previousSoc = null;
      previousTimestamp = null;
      continue;
    }

    const reportedSoc = point[reportedSocKey];
    if (Number.isFinite(reportedSoc)) {
      previousSoc = clampPercent(reportedSoc);
      point[socKey] = previousSoc;
      previousTimestamp = point.timestamp_ms;
      continue;
    }

    if (previousSoc === null) {
      previousSoc = Number.isFinite(point[socKey]) ? clampPercent(point[socKey]) : null;
    } else {
      const elapsedHours = (point.timestamp_ms - previousTimestamp) / 3600000;
      const currentA = point[currentKey];
      if (elapsedHours > 0 && elapsedHours <= (point.intervalMs * 3) / 3600000
        && Number.isFinite(currentA) && capacityAh > 0) {
        previousSoc = clampPercent(previousSoc + currentA * elapsedHours / capacityAh * 100);
      } else if (Number.isFinite(point[socKey])) {
        previousSoc = clampPercent(point[socKey]);
      }
    }

    point[socKey] = previousSoc;
    previousTimestamp = point.timestamp_ms;
  }
}

async function readBatteryIdentityAnalytics(db, identity, startMs, bucketMs) {
  if (!identity) return null;
  const slot = identity.slot;
  const batteryColumn = `battery${slot}_json`;
  const identityColumn = `battery${slot}_identity_id`;
  const socColumn = `battery${slot}_soc`;
  const sohColumn = `battery${slot}_soh`;
  const result = await db.prepare(`
    WITH recent AS (
      SELECT timestamp_ms,
             CAST(timestamp_ms / ? AS INTEGER) AS bucket,
             mode,
             ${batteryColumn} AS battery_json,
             ${socColumn} AS battery_soc,
             ${sohColumn} AS battery_soh
      FROM readings
      WHERE timestamp_ms >= ? AND ${identityColumn} = ?
    ),
    bucket_modes AS (
      SELECT bucket, mode,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY timestamp_ms DESC) AS row_num
      FROM recent
    )
    SELECT CAST(recent.bucket AS INTEGER) * ? AS timestamp_ms,
           MAX(CASE WHEN bucket_modes.row_num = 1 THEN recent.mode END) AS mode,
           AVG(CASE WHEN json_extract(recent.battery_json, '$.connected') = 1
               THEN ABS(CAST(json_extract(recent.battery_json, '$.current') AS REAL)) END) AS current_a,
           AVG(CASE WHEN json_extract(recent.battery_json, '$.connected') = 1
               THEN CAST(json_extract(recent.battery_json, '$.current') AS REAL) END) AS net_current_a,
           AVG(CASE WHEN json_extract(recent.battery_json, '$.connected') = 1
               THEN recent.battery_soc END) AS soc,
           AVG(CASE WHEN json_extract(recent.battery_json, '$.connected') = 1
               THEN COALESCE(json_extract(recent.battery_json, '$.soc_kalman'),
                     json_extract(recent.battery_json, '$.soc_coulomb'),
                     json_extract(recent.battery_json, '$.soc_ocv'),
                     json_extract(recent.battery_json, '$.soc')) END) AS reported_soc,
           AVG(CASE WHEN json_extract(recent.battery_json, '$.connected') = 1
               THEN recent.battery_soh END) AS soh,
           MAX(CASE WHEN json_extract(recent.battery_json, '$.connected') = 1 THEN 1 ELSE 0 END) AS connected
    FROM recent
    JOIN bucket_modes ON bucket_modes.bucket = recent.bucket AND bucket_modes.row_num = 1
    GROUP BY recent.bucket
    ORDER BY recent.bucket ASC
  `).bind(bucketMs, startMs, identity.id, bucketMs).all();
  const series = result.results.map((point) => ({
    timestamp_ms: Number(point.timestamp_ms),
    mode: point.mode,
    [`battery${slot}CurrentA`]: number(point.current_a),
    [`battery${slot}NetCurrentA`]: number(point.net_current_a),
    [`battery${slot}Soc`]: number(point.soc),
    [`battery${slot}ReportedSoc`]: number(point.reported_soc),
    [`battery${slot}Soh`]: number(point.soh),
    [`battery${slot}Connected`]: point.connected === 1,
    intervalMs: bucketMs,
  }));
  const ratedCapacityAh = identity.capacity_mah / 1000;
  recalculateSocForCapacity(series, slot, ratedCapacityAh);

  return {
    identityId: identity.id,
    slot,
    name: identity.name,
    ratedCapacityAh,
    sampleCount: series.length,
    series: series.map((point) => ({
      timestamp_ms: point.timestamp_ms,
      mode: point.mode,
      [`battery${slot}Soc`]: point[`battery${slot}Connected`] ? point[`battery${slot}Soc`] : null,
      [`battery${slot}DischargeA`]: point[`battery${slot}Connected`]
        ? point[`battery${slot}CurrentA`] : null,
    })),
    analytics: batteryAnalytics(series, slot),
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

async function readAnalytics(request, env) {
  try {
    const db = env.battery_management_db;
    const rangeDays = 1;
    const rangeMs = rangeDays * 24 * 60 * 60 * 1000;
    const bucketMs = Math.max(60000, Math.ceil(rangeMs / 10000 / 60000) * 60000);
    const identities = await getBatteryIdentities(db);
    const searchParams = new URL(request.url).searchParams;
    const chooseIdentity = (parameter, slot) => {
      const requestedId = Number(searchParams.get(parameter));
      return identities.find((identity) => identity.id === requestedId)
        || identities.find((identity) => identity.active && identity.slot === slot)
        || null;
    };
    const leftIdentity = chooseIdentity('leftBatteryId', 1);
    const rightIdentity = chooseIdentity('rightBatteryId', 2);
    const [left, right] = await Promise.all([
      readBatteryIdentityAnalytics(db, leftIdentity, Date.now() - rangeMs, bucketMs),
      readBatteryIdentityAnalytics(db, rightIdentity, Date.now() - rangeMs, bucketMs),
    ]);

    return json({
      days: rangeDays,
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

async function receiveTelemetry(request, env) {
  const unauthorized = authorizeDevice(request, env);
  if (unauthorized) return unauthorized;

  try {
    const data = await request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return json({ error: 'Telemetry must be a JSON object' }, 400);
    }

    const timestampMs = Date.now();
    const [previous, batterySpecs, pendingCapture] = await Promise.all([
      getLatestReading(env.battery_management_db),
      getBatterySpecs(env.battery_management_db),
      env.battery_management_db.prepare(`
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
    const captureRequestId = String(data.mode || '').trim().toUpperCase() !== 'SYSTEM OFF'
      ? pendingCapture?.id ?? null
      : null;
    const previousInIdentity = previous?.battery1_identity_id === (batterySpecs[1]?.identity_id ?? null)
      && previous?.battery2_identity_id === (batterySpecs[2]?.identity_id ?? null)
      ? previous
      : null;
    const elapsedSeconds = previousInIdentity
      ? Math.max(0, (timestampMs - previousInIdentity.timestamp_ms) / 1000)
      : 0;
    const battery1Soc = estimateSoc(battery1, previousInIdentity?.battery1_soc ?? null, elapsedSeconds, env, 1, batterySpecs);
    const battery2Soc = estimateSoc(battery2, previousInIdentity?.battery2_soc ?? null, elapsedSeconds, env, 2, batterySpecs);
    const battery1Soh = estimateSoh(battery1, env, 1, batterySpecs);
    const battery2Soh = estimateSoh(battery2, env, 2, batterySpecs);

    const result = await env.battery_management_db.prepare(`
      INSERT INTO readings (
        timestamp_ms, mode, switching, wifi_json, system_json,
        battery1_json, battery2_json,
        battery1_soc, battery2_soc, battery1_soh, battery2_soh, capture_request_id,
        battery1_identity_id, battery2_identity_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      timestampMs,
      data.mode ?? null,
      data.switching ? 1 : 0,
      JSON.stringify(wifi),
      JSON.stringify(system),
      JSON.stringify(battery1),
      JSON.stringify(battery2),
      battery1Soc,
      battery2Soc,
      battery1Soh,
      battery2Soh,
      captureRequestId,
      batterySpecs[1]?.identity_id ?? null,
      batterySpecs[2]?.identity_id ?? null,
    ).run();

    if (captureRequestId !== null) {
      await env.battery_management_db.prepare(`
        UPDATE reading_capture_requests
        SET status = 'captured', captured_at_ms = ?, reading_id = ?
        WHERE id = ? AND status = 'pending'
      `).bind(timestampMs, result.meta.last_row_id, captureRequestId).run();
    }

    return json({ success: true, receivedAt: timestampMs });
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
    const [row, batterySpecs] = await Promise.all([
      getLatestReading(env.battery_management_db),
      getBatterySpecs(env.battery_management_db),
    ]);
    if (!row) {
      return json({
        configured: true,
        battery1: { soc: null, soh: null, error: 'No D1 reading found', source: 'd1' },
        battery2: { soc: null, soh: null, error: 'No D1 reading found', source: 'd1' },
      });
    }

    return json({
      configured: true,
      battery1: healthForBattery(JSON.parse(row.battery1_json), row.battery1_soc, row.battery1_soh, env, 1, batterySpecs),
      battery2: healthForBattery(JSON.parse(row.battery2_json), row.battery2_soc, row.battery2_soh, env, 2, batterySpecs),
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
    if (pathname === '/api/reading-captures' && request.method === 'POST') return createReadingCapture(env);
    if (pathname === '/api/analytics' && request.method === 'GET') return readAnalytics(request, env);
    if (pathname === '/api/health' && request.method === 'GET') return getHealth(env);
    if (pathname === '/api/batteries' && request.method === 'GET') return readBatteries(env);
    if (pathname === '/api/batteries' && request.method === 'POST') return saveBattery(request, env);
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