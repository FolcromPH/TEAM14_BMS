// Battery health engine: temperature-free SOC, discharge-cycle tracking and per-cycle SOH.
//
// Pure functions only (no database, no network), so the same code runs in the Worker, in the
// CSV importer and in the unit tests.
//
// SOC  = coulomb counting (efficiency applied while charging)
//        + snap to 100 % when the charger reaches float/taper
//        + rest-voltage correction at the end of a discharge cycle (the "Switching" / "SYSTEM OFF" row).
//        It uses only voltage, current and time. Temperature is not used anywhere.
//
// SOH  = capacity of the Nth discharge cycle / capacity of the identity's first usable cycle * 100
//        capacity = (average load A * hours) / ((SOC_start - SOC_final) / 100)
//        With SOC_start = 100 this is exactly: Average Load Amperes * Time / (1 - SOC_final).
//        SOH only changes when a cycle completes, never per record.

export const HEALTH_DEFAULTS = {
  chargeEfficiency: 0.9,      // coulombic efficiency while charging
  maxStepSeconds: 60,         // never integrate across a longer gap than this
  interruptGapSeconds: 300,   // a gap this long inside a discharge cycle voids the cycle
  fullVoltage: 13.5,          // charger voltage that means "absorption/float"
  taperMinA: 0.03,            // full-charge current threshold = max(taperMinA, taperFractionC * C)
  taperFractionC: 0.005,
  ocvFullVoltage: 12.7,       // default rest voltage at 100 % (learned per battery once observed)
  ocvVoltsPerPercent: 0.008,  // 12 V lead-acid rest voltage slope
  ocvResistanceOhm: 0.03,     // small IR compensation for the few mA still flowing at the switch
  restMaxA: 0.3,              // a Switching-row reading is only trusted as "rest" below this current
  minDodPercent: 8,           // shallower cycles are not used for SOH
  minCycleSeconds: 900,
  medianWindow: 5,            // SOH smoothing window (cycles)
};

export const SWITCHING_MODE = 'Switching';
// Modes in which every relay is open and the batteries are (nearly) at rest. The sensor current is
// only a few mA, so the voltage is a usable open-circuit reading.
export const REST_MODES = ['Switching', 'SYSTEM OFF'];

export function isRestMode(mode) {
  return REST_MODES.includes(String(mode ?? '').trim());
}

export function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Battery 1 is the system battery: it powers the ESP32 in every mode, so it is "discharging"
// whenever Battery 2 is the one on the charger. Battery 2 discharges while Battery 1 charges.
export function dischargeModeFor(slot) {
  return slot === 1 ? 'Battery2 Charging' : 'Battery1 Charging';
}

// Rest-voltage -> SOC. fullVoltage is the rest voltage this battery shows at 100 %.
export function ocvSoc(voltage, current, fullVoltage, params = HEALTH_DEFAULTS) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  const i = isFiniteNumber(current) ? current : 0;
  const openCircuit = voltage - i * p.ocvResistanceOhm; // i is negative while discharging
  const full = isFiniteNumber(fullVoltage) ? fullVoltage : p.ocvFullVoltage;
  return clampPercent(100 - (full - openCircuit) / p.ocvVoltsPerPercent);
}

export function isFullyCharged(voltage, current, capacityAh, params = HEALTH_DEFAULTS) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  if (!isFiniteNumber(voltage) || !isFiniteNumber(current)) return false;
  const taper = Math.max(p.taperMinA, p.taperFractionC * (capacityAh || 0));
  return voltage >= p.fullVoltage && current >= 0 && current <= taper;
}

// One coulomb-counting step. prevSoc may be null (first reading): then an OCV estimate is used.
export function stepSoc({ prevSoc, dtSeconds, voltage, current, capacityAh, fullVoltage }, params = HEALTH_DEFAULTS) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  let soc = isFiniteNumber(prevSoc) ? prevSoc : ocvSoc(voltage, current, fullVoltage, p);
  if (isFiniteNumber(prevSoc) && dtSeconds > 0 && dtSeconds <= p.maxStepSeconds
      && isFiniteNumber(current) && capacityAh > 0) {
    const efficiency = current > 0 ? p.chargeEfficiency : 1;
    soc += (efficiency * current * dtSeconds) / 3600 / capacityAh * 100;
  }
  soc = clampPercent(soc);
  if (isFullyCharged(voltage, current, capacityAh, p)) soc = 100;
  return soc;
}

// Learn the rest voltage a battery shows at 100 %: only from a rest row (Switching / SYSTEM OFF) right after a full charge.
export function learnFullVoltage(previous, { mode, soc, voltage, current }, params = HEALTH_DEFAULTS) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  if (!isRestMode(mode) || !isFiniteNumber(voltage) || !isFiniteNumber(current)) return previous ?? null;
  if (!(soc >= 99.9) || Math.abs(current) > p.restMaxA) return previous ?? null;
  const rest = voltage - current * p.ocvResistanceOhm;
  return isFiniteNumber(previous) ? previous * 0.7 + rest * 0.3 : rest;
}

// Track one slot's discharge cycle. Returns { tracker, finished, socOverride }.
// event: { slot, mode, tsMs, dtSeconds, voltage, current, soc, prevSoc, fullVoltage }
export function advanceCycle(tracker, event, params = HEALTH_DEFAULTS) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  const discharging = event.mode === dischargeModeFor(event.slot);

  if (discharging) {
    let t = tracker;
    if (!t) {
      t = {
        startMs: event.tsMs,
        socStart: isFiniteNumber(event.prevSoc) ? event.prevSoc : event.soc,
        socMin: event.soc,
        ah: 0,
        seconds: 0,
        interrupted: false,
        lastMs: event.tsMs,
      };
    } else {
      if (event.dtSeconds > p.interruptGapSeconds) t.interrupted = true;
      const dt = Math.max(0, Math.min(event.dtSeconds, p.maxStepSeconds));
      if (isFiniteNumber(event.current) && event.current < 0) t.ah += (-event.current * dt) / 3600;
      t.seconds += dt;
      t.socMin = Math.min(t.socMin, event.soc);
      t.lastMs = event.tsMs;
    }
    return { tracker: t, finished: null, socOverride: null };
  }

  if (!tracker) return { tracker: null, finished: null, socOverride: null };

  // The discharge phase just ended.
  let socFinal = tracker.socMin;
  let source = 'cc';
  let socOverride = null;
  if (isRestMode(event.mode) && !tracker.interrupted
      && isFiniteNumber(event.fullVoltage) && isFiniteNumber(event.voltage)
      && isFiniteNumber(event.current) && Math.abs(event.current) <= p.restMaxA) {
    const rest = ocvSoc(event.voltage, event.current, event.fullVoltage, p);
    socFinal = Math.min(rest, tracker.socStart);
    source = 'ocv';
    socOverride = socFinal;
  }
  const dod = tracker.socStart - socFinal;
  if (tracker.interrupted || dod < p.minDodPercent || tracker.seconds < p.minCycleSeconds || tracker.ah <= 0) {
    return { tracker: null, finished: null, socOverride };
  }
  const hours = tracker.seconds / 3600;
  return {
    tracker: null,
    socOverride,
    finished: {
      slot: event.slot,
      startedMs: tracker.startMs,
      endedMs: tracker.lastMs,
      hours,
      avgLoadA: tracker.ah / hours,
      dischargedAh: tracker.ah,
      socStart: tracker.socStart,
      socFinal,
      socFinalSource: source,
      dodPercent: dod,
      capacityAh: capacityFromCycle(tracker.ah, dod),
    },
  };
}

// capacity = (average load * hours) / depth of discharge, where average load * hours = discharged Ah.
export function capacityFromCycle(dischargedAh, dodPercent) {
  return dodPercent > 0 ? dischargedAh / (dodPercent / 100) : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Score a finished cycle.
//   baselineAh  : capacity of this battery's first usable cycle (null if this cycle is the first)
//   recentRaw   : raw SOH of this battery's previous cycles, oldest first
//   lastReported: SOH currently shown for this battery (null if none)
// Only 'ocv' cycles (voltage-informed SOC_final) are usable: a coulomb-only SOC_final reproduces the
// rated capacity by construction and could never show fade.
export function scoreCycle(cycle, { baselineAh, recentRaw = [], lastReported = null }, params = HEALTH_DEFAULTS) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  if (cycle.socFinalSource !== 'ocv' || !isFiniteNumber(cycle.capacityAh)) {
    return { usable: false, baselineAh: baselineAh ?? null, sohRaw: null, sohReported: lastReported };
  }
  const baseline = isFiniteNumber(baselineAh) ? baselineAh : cycle.capacityAh;
  const sohRaw = (cycle.capacityAh / baseline) * 100;
  const window = [...recentRaw, sohRaw].slice(-p.medianWindow);
  let sohReported = median(window);
  if (isFiniteNumber(lastReported)) sohReported = Math.min(sohReported, lastReported); // never rises
  return { usable: true, baselineAh: baseline, sohRaw, sohReported };
}

// One telemetry reading through the whole engine.
//   state : { prevTsMs, slots: { 1: SlotState, 2: SlotState } }
//   SlotState = { capacityAh, soc, tsMs, tracker, fullVoltage, connected }
//   input : { tsMs, mode, slots: { 1: { connected, voltage, current, reportedSoc? }, 2: {...} } }
//   options.freeze: true while the user still has to confirm which batteries are connected
//                   (SOC keeps running, cycles are not tracked).
export function processTelemetry(state, input, params = HEALTH_DEFAULTS, options = {}) {
  const p = { ...HEALTH_DEFAULTS, ...params };
  const result = { slots: {}, finishedCycles: [] };

  // Learn rest voltages first: the charging battery finishing at 100 % must not depend on the other slot.
  for (const slot of [1, 2]) {
    const prev = state.slots[slot];
    const reading = input.slots[slot];
    const dtSeconds = isFiniteNumber(prev.tsMs) ? Math.max(0, (input.tsMs - prev.tsMs) / 1000) : 0;

    if (!reading.connected || !isFiniteNumber(reading.voltage)) {
      result.slots[slot] = {
        soc: null, tsMs: input.tsMs, tracker: null, fullVoltage: prev.fullVoltage ?? null,
        fullVoltageChanged: false, connected: false,
      };
      continue;
    }

    // A firmware-reported SOC (BMS, Kalman, ...) wins over the Worker's own estimate when present.
    let soc = isFiniteNumber(reading.reportedSoc)
      ? clampPercent(reading.reportedSoc)
      : stepSoc({
        prevSoc: prev.soc, dtSeconds, voltage: reading.voltage, current: reading.current,
        capacityAh: prev.capacityAh, fullVoltage: prev.fullVoltage,
      }, p);

    const fullVoltage = learnFullVoltage(prev.fullVoltage, {
      mode: input.mode, soc, voltage: reading.voltage, current: reading.current,
    }, p);

    let tracker = prev.tracker ?? null;
    if (options.freeze || !prev.connected) {
      tracker = null;
    } else {
      const outcome = advanceCycle(tracker, {
        slot, mode: input.mode, tsMs: input.tsMs, dtSeconds, voltage: reading.voltage,
        current: reading.current, soc, prevSoc: prev.soc, fullVoltage: prev.fullVoltage,
      }, p);
      tracker = outcome.tracker;
      if (outcome.socOverride !== null) soc = outcome.socOverride;
      if (outcome.finished) result.finishedCycles.push(outcome.finished);
    }

    result.slots[slot] = {
      soc, tsMs: input.tsMs, tracker, fullVoltage,
      fullVoltageChanged: fullVoltage !== (prev.fullVoltage ?? null), connected: true,
    };
  }
  return result;
}
