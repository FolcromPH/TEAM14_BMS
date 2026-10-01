const HEADERS = [
  'Reading ID', 'Timestamp', 'Mode', 'Switching', 'Wi-Fi connected', 'Wi-Fi RSSI',
  'Battery 1 INA found', 'Battery 1 voltage (V)', 'Battery 1 current (A)',
  'Battery 1 power (W)', 'Battery 1 temperature (C)', 'Battery 1 SOC (%)',
  'Battery 1 SOH (%)', 'Battery 2 INA found', 'Battery 2 voltage (V)',
  'Battery 2 current (A)', 'Battery 2 power (W)', 'Battery 2 temperature (C)',
  'Battery 2 SOC (%)', 'Battery 2 SOH (%)', 'Brownout detected', 'Previous session (legacy)',
  'Battery 1 Identity ID', 'Battery 1 Name', 'Battery 2 Identity ID', 'Battery 2 Name',
  'Capture Request ID',
];

function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (const header of HEADERS) {
    if (!existingHeaders.includes(header)) {
      sheet.getRange(1, HEADERS.indexOf(header) + 1).setValue(header);
    }
  }
}

function readingRow(reading) {
  const battery1 = reading.battery1 || {};
  const battery2 = reading.battery2 || {};
  const wifi = reading.wifi || {};
  const system = reading.system || {};

  return [
    reading.id,
    new Date(reading.timestampMs),
    reading.mode || '',
    Boolean(reading.switching),
    Boolean(wifi.connected),
    wifi.rssi ?? '',
    Boolean(battery1.connected),
    battery1.voltage ?? '',
    battery1.current ?? '',
    battery1.power ?? '',
    battery1.temperature ?? '',
    battery1.soc ?? '',
    battery1.soh ?? '',
    Boolean(battery2.connected),
    battery2.voltage ?? '',
    battery2.current ?? '',
    battery2.power ?? '',
    battery2.temperature ?? '',
    battery2.soc ?? '',
    battery2.soh ?? '',
    Boolean(system.brownoutDetected),
    '',
    battery1.identityId ?? '',
    battery1.identityName ?? '',
    battery2.identityId ?? '',
    battery2.identityName ?? '',
    reading.captureRequestId ?? '',
  ];
}

function appendCaptureTab(spreadsheet, reading, row) {
  if (reading.captureRequestId === null || reading.captureRequestId === undefined || reading.captureRequestId === '') return false;

  const batteryNames = [reading.battery1?.identityName, reading.battery2?.identityName]
    .filter(Boolean)
    .join(' + ');
  const tabName = `Capture ${reading.captureRequestId}${batteryNames ? ` - ${batteryNames}` : ''}`
    .replace(/[:\\/?*\[\]]/g, '-')
    .slice(0, 100);
  const sheet = spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
  ensureHeaders(sheet);

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const readingIds = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    if (readingIds.some((id) => Number(id) === Number(reading.id))) return false;
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length).setValues([row]);
  return true;
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ success: false, error: 'Sheet is busy' });

  try {
    const body = JSON.parse(event?.postData?.contents || '{}');
    const properties = PropertiesService.getScriptProperties();
    const expectedToken = properties.getProperty('SYNC_TOKEN');
    if (!expectedToken || body.token !== expectedToken) {
      return jsonResponse({ success: false, error: 'Unauthorized' });
    }

    const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) return jsonResponse({ success: false, error: 'SPREADSHEET_ID is not configured' });

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName('Readings') || spreadsheet.insertSheet('Readings');
    ensureHeaders(sheet);

    const readings = Array.isArray(body.readings) ? body.readings : [];
    const lastReadingId = sheet.getLastRow() > 1
      ? Number(sheet.getRange(sheet.getLastRow(), 1).getValue()) || 0
      : 0;
    const newReadings = readings
      .filter((reading) => Number(reading.id) > lastReadingId)
    const newRows = newReadings.map(readingRow);

    if (newRows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, HEADERS.length).setValues(newRows);
    }

    const captureTabsCreated = readings.reduce(
      (count, reading) => count + (appendCaptureTab(spreadsheet, reading, readingRow(reading)) ? 1 : 0),
      0,
    );
    return jsonResponse({ success: true, appended: newRows.length, captureTabsCreated });
  } catch (error) {
    return jsonResponse({ success: false, error: String(error) });
  } finally {
    lock.releaseLock();
  }
}

function resetSpreadsheetForFreshStart() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Sheet is busy. Try again in a moment.');

  try {
    const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('SPREADSHEET_ID is not configured');

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const readingsSheet = spreadsheet.getSheetByName('Readings');
    let clearedRows = 0;
    if (readingsSheet) {
      const lastRow = readingsSheet.getLastRow();
      const lastColumn = readingsSheet.getLastColumn();
      if (lastRow > 1 && lastColumn > 0) {
        clearedRows = lastRow - 1;
        readingsSheet.getRange(2, 1, clearedRows, lastColumn).clearContent();
      }
      ensureHeaders(readingsSheet);
    }

    const captureTabs = spreadsheet.getSheets().filter((sheet) => /^Capture \d+/.test(sheet.getName()));
    captureTabs.forEach((sheet) => spreadsheet.deleteSheet(sheet));

    const result = { success: true, clearedRows, deletedCaptureTabs: captureTabs.length };
    Logger.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
