#!/usr/bin/env node
// Imports a Dataset-2-format CSV (the same layout the dashboard exports and Google Sheets stores)
// into D1, so the Database reader / Analytics "Custom dates" range can look the data up by timestamp.
//
//   node scripts/import-csv.mjs                       # writes SQL chunks to data/import/
//   node scripts/import-csv.mjs --apply local         # ...and runs them against the local D1
//   node scripts/import-csv.mjs --apply remote        # ...and runs them against the deployed D1
//
// Options
//   --file data/Dataset_2.csv   CSV to import
//   --tz +08:00                 time zone the CSV timestamps are written in (default Asia/Manila)
//   --capacity 40               rated Ah of the imported batteries (or --capacity1 / --capacity2)
//   --voltage 12                nominal voltage of the imported batteries
//   --cycles csv|none           csv: one scored cycle per step of the recorded SOH column
//   --chunk 200                 rows per INSERT (D1 allows at most 100 KB per statement)
//   --db battery-management-db  D1 database name from wrangler.jsonc
//
// The batteries in the CSV are saved by NAME (their "Battery 1 Name" / "Battery 2 Name" columns), so they show
// up as saved batteries and never touch the batteries currently in the slots. Re-running the import replaces
// the rows it imported before; it never deletes anything else.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CSV_HEADERS, parseTimestamp } from '../src/lib/csv.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    file: 'data/Dataset_2.csv', tz: '+08:00', capacity1: 40, capacity2: 40, voltage: 12,
    cycles: 'csv', chunk: 200, perFile: 10, db: 'battery-management-db', out: 'data/import', apply: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (key === 'capacity') { options.capacity1 = Number(value); options.capacity2 = Number(value); }
    else if (['capacity1', 'capacity2', 'voltage', 'chunk', 'perFile'].includes(key)) options[key] = Number(value);
    else if (['file', 'tz', 'cycles', 'db', 'out', 'apply'].includes(key)) options[key] = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (options.apply && !['local', 'remote'].includes(options.apply)) throw new Error('--apply must be local or remote');
  if (!['csv', 'none'].includes(options.cycles)) throw new Error('--cycles must be csv or none');
  for (const key of ['capacity1', 'capacity2', 'voltage', 'chunk', 'perFile']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be a positive number`);
  }
  return options;
}

function offsetMinutes(text) {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
  if (!match) throw new Error('--tz must look like +08:00');
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

// Small CSV reader that understands quoted fields.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sqlNumber = (value) => (Number.isFinite(value) ? String(value) : 'NULL');
const toNumber = (text) => (text === undefined || text === '' ? null : (Number.isFinite(Number(text)) ? Number(text) : null));
const toBool = (text) => String(text).trim().toUpperCase() === 'TRUE';

function loadRows(options) {
  const text = fs.readFileSync(path.resolve(root, options.file), 'utf8').replace(/^﻿/, '');
  const table = parseCsv(text);
  const header = table[0].map((name) => name.trim());
  const missing = ['Timestamp', 'Mode', 'Battery 1 voltage (V)', 'Battery 2 voltage (V)'].filter((name) => !header.includes(name));
  if (missing.length) throw new Error(`This does not look like a Dataset 2 CSV: missing ${missing.join(', ')}`);
  const at = (name) => header.indexOf(name);
  const col = Object.fromEntries(CSV_HEADERS.map((name) => [name, at(name)]));
  const offset = offsetMinutes(options.tz);
  const rows = [];
  for (const [lineIndex, cells] of table.slice(1).entries()) {
    const get = (name) => (col[name] >= 0 ? cells[col[name]] : undefined);
    const tsMs = parseTimestamp(get('Timestamp') ?? '', offset);
    if (tsMs === null) throw new Error(`Line ${lineIndex + 2}: cannot read timestamp "${get('Timestamp')}" (expected m/d/yyyy h:mm:ss)`);
    const battery = (n) => {
      const connected = toBool(get(`Battery ${n} INA found`));
      return {
        connected,
        voltage: toNumber(get(`Battery ${n} voltage (V)`)),
        current: toNumber(get(`Battery ${n} current (A)`)),
        power: toNumber(get(`Battery ${n} power (W)`)),
        temperature: toNumber(get(`Battery ${n} temperature (C)`)),
        soc: toNumber(get(`Battery ${n} SOC (%)`)),
        soh: toNumber(get(`Battery ${n} SOH (%)`)),
        name: (get(`Battery ${n} Name`) ?? '').trim() || `Imported battery ${n}`,
      };
    };
    rows.push({
      tsMs,
      mode: get('Mode') ?? '',
      switching: toBool(get('Switching')),
      wifi: { connected: toBool(get('Wi-Fi connected')), rssi: toNumber(get('Wi-Fi RSSI')) },
      brownout: toBool(get('Brownout detected')),
      b: { 1: battery(1), 2: battery(2) },
    });
  }
  rows.sort((a, b) => a.tsMs - b.tsMs);
  return rows;
}

// One scored cycle per step of the recorded SOH column: the cycle runs from the previous step to this one.
function cyclesFromSoh(rows, slot, ratedAh) {
  const cycles = [];
  let previousSoh = null;
  let from = 0;
  let acc = null;
  const reset = () => { acc = { hours: 0, ah: 0, socFirst: null, socLast: null }; };
  reset();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const battery = row.b[slot];
    if (i > 0 && battery.connected && Number.isFinite(battery.current) && battery.current < -0.02
      && !['Switching', 'SYSTEM OFF'].includes(row.mode)) {
      const dt = (row.tsMs - rows[i - 1].tsMs) / 1000;
      if (dt > 0 && dt <= 60) {
        acc.hours += dt / 3600;
        acc.ah += (-battery.current * dt) / 3600;
        if (acc.socFirst === null && Number.isFinite(battery.soc)) acc.socFirst = battery.soc;
        if (Number.isFinite(battery.soc)) acc.socLast = battery.soc;
      }
    }
    if (!Number.isFinite(battery.soh)) continue;
    if (previousSoh === null) { previousSoh = battery.soh; from = i; continue; }
    if (Math.abs(battery.soh - previousSoh) < 1e-9) continue;
    if (acc.hours > 0 && acc.socFirst !== null) {
      const dod = Math.max(0, acc.socFirst - acc.socLast);
      cycles.push({
        slot,
        startedMs: rows[from].tsMs,
        endedMs: row.tsMs,
        hours: acc.hours,
        avgLoadA: acc.ah / acc.hours,
        dischargedAh: acc.ah,
        socStart: acc.socFirst,
        socFinal: acc.socLast,
        dod,
        capacityAh: (ratedAh * battery.soh) / 100,
        soh: battery.soh,
      });
    }
    previousSoh = battery.soh;
    from = i;
    reset();
  }
  return cycles;
}

function identityUpsert(slot, name, options) {
  const capacityMah = (slot === 1 ? options.capacity1 : options.capacity2) * 1000;
  return `INSERT INTO battery_identities (slot, name, voltage_v, capacity_mah, created_at_ms)
SELECT ${slot}, ${sqlText(name)}, ${options.voltage}, ${capacityMah}, ${Date.now()}
WHERE NOT EXISTS (SELECT 1 FROM battery_identities WHERE slot = ${slot} AND name = ${sqlText(name)} COLLATE NOCASE);`;
}

const idOf = (slot, name) => `(SELECT id FROM battery_identities WHERE slot = ${slot} AND name = ${sqlText(name)} COLLATE NOCASE ORDER BY id LIMIT 1)`;

function readingValues(row) {
  const json = (b) => JSON.stringify({
    connected: b.connected, voltage: b.voltage, current: b.current, power: b.power, temperature: b.temperature,
  });
  const keep = (b, value) => (b.connected ? sqlNumber(value) : 'NULL');
  return `(${row.tsMs}, ${sqlText(row.mode)}, ${row.switching ? 1 : 0}, ${sqlText(JSON.stringify(row.wifi))}, ${sqlText(JSON.stringify({ brownoutDetected: row.brownout }))}, `
    + `${sqlText(json(row.b[1]))}, ${sqlText(json(row.b[2]))}, ${keep(row.b[1], row.b[1].soc)}, ${keep(row.b[2], row.b[2].soc)}, `
    + `${keep(row.b[1], row.b[1].soh)}, ${keep(row.b[2], row.b[2].soh)})`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = loadRows(options);
  if (rows.length === 0) throw new Error('The CSV has no data rows');
  const names = { 1: rows[0].b[1].name, 2: rows[0].b[2].name };
  const first = rows[0].tsMs;
  const last = rows[rows.length - 1].tsMs;
  const outDir = path.resolve(root, options.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  const write = (name, statements) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, `${statements.join('\n')}\n`);
    files.push(file);
  };

  // 000: identities + remove what an earlier import of the same names put in this time window.
  const prelude = [identityUpsert(1, names[1], options), identityUpsert(2, names[2], options)];
  prelude.push(`DELETE FROM battery_cycles WHERE soc_final_source = 'csv' AND (identity_id = ${idOf(1, names[1])} OR identity_id = ${idOf(2, names[2])});`);
  prelude.push(`DELETE FROM readings WHERE timestamp_ms BETWEEN ${first} AND ${last} AND battery1_identity_id = ${idOf(1, names[1])} AND battery2_identity_id = ${idOf(2, names[2])};`);
  write('000-identities.sql', prelude);

  const columns = 'timestamp_ms, mode, switching, wifi_json, system_json, battery1_json, battery2_json, battery1_soc, battery2_soc, battery1_soh, battery2_soh, capture_request_id, battery1_identity_id, battery2_identity_id';
  const valueColumns = 'column1, column2, column3, column4, column5, column6, column7, column8, column9, column10, column11';
  const insertStatements = [];
  for (let i = 0; i < rows.length; i += options.chunk) {
    const values = rows.slice(i, i + options.chunk).map(readingValues);
    insertStatements.push(`INSERT INTO readings (${columns})
WITH ids(i1, i2) AS (SELECT ${idOf(1, names[1])}, ${idOf(2, names[2])})
SELECT ${valueColumns}, NULL, ids.i1, ids.i2 FROM ids, (VALUES\n${values.join(',\n')});`);
  }
  let chunkNumber = 1;
  for (let i = 0; i < insertStatements.length; i += options.perFile) {
    write(`${String(chunkNumber).padStart(3, '0')}-readings.sql`, insertStatements.slice(i, i + options.perFile));
    chunkNumber += 1;
  }

  let cycleCount = 0;
  if (options.cycles === 'csv') {
    const all = [1, 2].flatMap((slot) => cyclesFromSoh(rows, slot, slot === 1 ? options.capacity1 : options.capacity2));
    const numbers = { 1: 0, 2: 0 };
    all.sort((a, b) => a.endedMs - b.endedMs);
    const statements = all.map((c) => {
      numbers[c.slot] += 1;
      return `INSERT OR IGNORE INTO battery_cycles (identity_id, slot, cycle_number, started_at_ms, ended_at_ms, hours, avg_load_a, discharged_ah, soc_start, soc_final, soc_final_source, dod_percent, capacity_ah, soh_raw, soh_reported, created_at_ms) `
        + `VALUES (${idOf(c.slot, names[c.slot])}, ${c.slot}, ${numbers[c.slot]}, ${c.startedMs}, ${c.endedMs}, ${c.hours}, ${c.avgLoadA}, ${c.dischargedAh}, ${c.socStart}, ${c.socFinal}, 'csv', ${c.dod}, ${c.capacityAh}, ${c.soh}, ${c.soh}, ${Date.now()});`;
    });
    cycleCount = statements.length;
    for (let i = 0; i < statements.length; i += 500) {
      write(`${String(chunkNumber).padStart(3, '0')}-cycles.sql`, statements.slice(i, i + 500));
      chunkNumber += 1;
    }
  }

  console.log(`Read ${rows.length.toLocaleString()} rows (${new Date(first).toISOString()} to ${new Date(last).toISOString()}, CSV time zone ${options.tz}).`);
  console.log(`Batteries: slot 1 "${names[1]}" (${options.capacity1} Ah), slot 2 "${names[2]}" (${options.capacity2} Ah). Cycles from the recorded SOH column: ${cycleCount}.`);
  console.log(`Wrote ${files.length} SQL files to ${path.relative(process.cwd(), outDir) || '.'}`);

  if (!options.apply) {
    console.log('\nNext, run them against D1 (local first):');
    console.log(`  node scripts/import-csv.mjs --apply local`);
    console.log(`  node scripts/import-csv.mjs --apply remote   # the deployed Worker`);
    return;
  }
  for (const [index, file] of files.entries()) {
    const args = ['wrangler', 'd1', 'execute', options.db, `--${options.apply}`, '--file', file];
    const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: root });
    if (result.status !== 0) {
      console.error(`\nStopped at ${path.basename(file)} (${index + 1}/${files.length}). Fix the problem and run the same command again; the import replaces its own earlier rows.`);
      process.exit(result.status ?? 1);
    }
    console.log(`Applied ${path.basename(file)} (${index + 1}/${files.length})`);
  }
  console.log('\nDone. Open Database reader or Analytics, choose "Custom", and pick a date inside the CSV.');
}

try {
  main();
} catch (error) {
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
}
