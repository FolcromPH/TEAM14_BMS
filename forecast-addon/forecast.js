// SOH forecasting: ordinary least-squares line through the per-cycle SOH values, with a measured
// error band. Pure JavaScript with no dependencies, so it runs in the Worker, in the browser,
// in Node tests and (with the running-sum version in soh_forecast.js) on an ESP32.
//
// Error band ("how far off is the forecast from the SOH we then actually measured"):
//   walk-forward backtest: for every cycle i >= minTrain, fit on cycles 1..i-1, predict cycle i and
//   compare with the SOH that was really measured for cycle i. The 90th-percentile absolute error
//   (percentage points) becomes the +/- range. Until enough cycles exist, a nominal +/-5 % is shown
//   and labelled as assumed.

export const FORECAST_DEFAULTS = {
  minTrain: 5,          // cycles needed before a backtest is meaningful
  minFit: 3,            // cycles needed before any line is drawn
  assumedBand: 0.05,    // +/-5 % until measured error is available
  threshold: 80,        // end-of-life SOH (%)
  horizon: 20,          // cycles projected ahead for the chart
};

export function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const denominator = n * sxx - sx * sx;
  if (denominator === 0) return null;
  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const fit = intercept + slope * xs[i];
    ssRes += (ys[i] - fit) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot, n };
}

function percentile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

// cycles: [{ cycle, sohRaw, sohReported, endedMs? }] oldest first, one entry per usable cycle.
// The line is fitted on sohReported (smoothed, never rising); accuracy is judged against sohRaw,
// the value that was actually measured for that cycle.
export function backtest(cycles, options = {}) {
  const o = { ...FORECAST_DEFAULTS, ...options };
  const errors = [];
  for (let i = o.minTrain; i < cycles.length; i += 1) {
    const train = cycles.slice(0, i);
    const line = fitLine(train.map((c) => c.cycle), train.map((c) => c.sohReported));
    if (!line) continue;
    const predicted = line.intercept + line.slope * cycles[i].cycle;
    const actual = cycles[i].sohRaw;
    errors.push({ cycle: cycles[i].cycle, predicted, actual, errorPts: predicted - actual });
  }
  if (errors.length === 0) return { samples: 0, errors };
  const abs = errors.map((e) => Math.abs(e.errorPts)).sort((a, b) => a - b);
  const mae = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rmse = Math.sqrt(errors.reduce((a, e) => a + e.errorPts ** 2, 0) / errors.length);
  const mape = errors.reduce((a, e) => a + Math.abs(e.errorPts) / Math.abs(e.actual), 0) / errors.length * 100;
  return {
    samples: errors.length,
    maePts: mae,
    rmsePts: rmse,
    mapePercent: mape,
    p90Pts: percentile(abs, 0.9),
    withinFivePts: errors.filter((e) => Math.abs(e.errorPts) <= 5).length / errors.length * 100,
    withinFivePercent: errors.filter((e) => Math.abs(e.errorPts) / Math.abs(e.actual) <= 0.05).length / errors.length * 100,
    errors,
  };
}

export function buildForecast(cycles, options = {}) {
  const o = { ...FORECAST_DEFAULTS, ...options };
  const usable = cycles.filter((c) => Number.isFinite(c.sohReported) && Number.isFinite(c.sohRaw));
  const points = usable.map((c) => ({ cycle: c.cycle, raw: c.sohRaw, reported: c.sohReported, endedMs: c.endedMs ?? null }));
  const base = { cycleCount: usable.length, points, threshold: o.threshold };
  if (usable.length === 0) return { ...base, status: 'no-cycles' };

  const latest = usable[usable.length - 1];
  const line = usable.length >= o.minFit ? fitLine(usable.map((c) => c.cycle), usable.map((c) => c.sohReported)) : null;
  if (!line) return { ...base, status: 'collecting', latestSoh: latest.sohReported };

  const test = backtest(usable, o);
  const measured = test.samples >= 3;
  const nextCycle = latest.cycle + 1;
  const nextSoh = line.intercept + line.slope * nextCycle;
  const halfWidthPts = measured ? Math.max(test.p90Pts, 0.005) : nextSoh * o.assumedBand;
  const band = {
    kind: measured ? 'measured' : 'assumed',
    halfWidthPts,
    halfWidthPercent: nextSoh !== 0 ? (halfWidthPts / nextSoh) * 100 : null,
    backtest: measured ? {
      samples: test.samples, maePts: test.maePts, rmsePts: test.rmsePts, mapePercent: test.mapePercent,
      p90Pts: test.p90Pts, withinFivePts: test.withinFivePts, withinFivePercent: test.withinFivePercent,
    } : null,
  };

  // Cycles until the SOH line reaches the threshold; the band moves that point earlier/later.
  let toThreshold = null;
  if (line.slope < 0) {
    const at = (offset) => (o.threshold + offset - line.intercept) / line.slope;
    const crossing = (value) => Math.max(latest.cycle, Math.ceil(value));
    const timeSpanMs = usable.length > 1 && Number.isFinite(usable[0].endedMs) && Number.isFinite(latest.endedMs)
      ? latest.endedMs - usable[0].endedMs : null;
    const cyclesPerDay = timeSpanMs > 0 ? ((latest.cycle - usable[0].cycle) / (timeSpanMs / 86400000)) : null;
    toThreshold = {
      earliest: crossing(at(halfWidthPts)),
      expected: crossing(at(0)),
      latest: crossing(at(-halfWidthPts)),
      cyclesPerDay,
      daysExpected: cyclesPerDay > 0 ? Math.max(0, (crossing(at(0)) - latest.cycle) / cyclesPerDay) : null,
    };
  }

  const projection = [];
  for (let k = 0; k <= o.horizon; k += 1) {
    const cycle = latest.cycle + k;
    const soh = line.intercept + line.slope * cycle;
    projection.push({ cycle, soh, lower: soh - halfWidthPts, upper: soh + halfWidthPts });
  }

  return {
    ...base,
    status: 'ready',
    latestSoh: latest.sohReported,
    slopePerCycle: line.slope,
    intercept: line.intercept,
    r2: line.r2,
    next: { cycle: nextCycle, soh: nextSoh, lower: nextSoh - halfWidthPts, upper: nextSoh + halfWidthPts },
    predictedDropNextCycle: Math.max(0, latest.sohReported - nextSoh),
    band,
    toThreshold,
    projection,
    fit: usable.map((c) => ({ cycle: c.cycle, fit: line.intercept + line.slope * c.cycle })),
  };
}
