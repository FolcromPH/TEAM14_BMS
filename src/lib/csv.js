// CSV helpers shared by the Worker (export) and scripts/import-csv.mjs (import).
// The column order is the Dataset 2 / Google Sheets layout, unchanged.

export const CSV_HEADERS = [
  'Reading ID', 'Timestamp', 'Mode', 'Switching', 'Wi-Fi connected', 'Wi-Fi RSSI',
  'Battery 1 INA found', 'Battery 1 voltage (V)', 'Battery 1 current (A)',
  'Battery 1 power (W)', 'Battery 1 temperature (C)', 'Battery 1 SOC (%)',
  'Battery 1 SOH (%)', 'Battery 2 INA found', 'Battery 2 voltage (V)',
  'Battery 2 current (A)', 'Battery 2 power (W)', 'Battery 2 temperature (C)',
  'Battery 2 SOC (%)', 'Battery 2 SOH (%)', 'Brownout detected', 'Previous session (legacy)',
  'Battery 1 Identity ID', 'Battery 1 Name', 'Battery 2 Identity ID', 'Battery 2 Name',
  'Capture Request ID',
];

function trimNumber(value, decimals) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const text = n.toFixed(decimals);
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  return trimmed === '-0' ? '0' : trimmed;
}

function bool(value) {
  return value ? 'TRUE' : 'FALSE';
}

function escapeField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// "9/24/2026 0:00:00" in the given IANA time zone (the Dataset 2 style).
export function formatTimestamp(ms, timeZone = 'Asia/Manila') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${Number(parts.month)}/${Number(parts.day)}/${parts.year} ${Number(parts.hour)}:${parts.minute}:${parts.second}`;
}

// "m/d/yyyy h:mm:ss" (no zone) -> epoch ms, interpreting the text at a fixed UTC offset in minutes.
export function parseTimestamp(text, offsetMinutes = 480) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  const [, month, day, year, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60000;
}

// One stored reading -> one CSV line in the Dataset 2 layout.
// reading: { id, timestamp_ms, mode, switching, wifi, system, battery1, battery2, captureRequestId, ...identity names }
export function readingToCsvLine(reading, timeZone) {
  const b1 = reading.battery1 ?? {};
  const b2 = reading.battery2 ?? {};
  const wifi = reading.wifi ?? {};
  const system = reading.system ?? {};
  const wifiConnected = wifi.connected ?? system.wifiConnected;
  return [
    reading.id,
    formatTimestamp(reading.timestamp_ms, timeZone),
    reading.mode ?? '',
    bool(reading.switching),
    bool(wifiConnected),
    wifi.rssi ?? '',
    bool(b1.connected),
    trimNumber(b1.voltage, 4), trimNumber(b1.current, 5), trimNumber(b1.power, 2), trimNumber(b1.temperature, 1),
    trimNumber(b1.soc, 8), trimNumber(b1.soh, 4),
    bool(b2.connected),
    trimNumber(b2.voltage, 4), trimNumber(b2.current, 5), trimNumber(b2.power, 2), trimNumber(b2.temperature, 1),
    trimNumber(b2.soc, 8), trimNumber(b2.soh, 4),
    bool(system.brownoutDetected),
    '',
    b1.identityId ?? '', b1.identityName ?? '', b2.identityId ?? '', b2.identityName ?? '',
    reading.captureRequestId ?? '',
  ].map(escapeField).join(',');
}
