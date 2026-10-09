import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatValue } from './chartUtils.js'

function Stat({ label, value, detail }) {
  return (
    <div className="forecast-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

// One row per cycle number: measured points + fit line for past cycles, projection + error band for future ones.
export function buildChartRows(forecast) {
  const rows = new Map()
  const row = (cycle) => {
    if (!rows.has(cycle)) rows.set(cycle, { cycle })
    return rows.get(cycle)
  }
  for (const point of forecast.points ?? []) {
    Object.assign(row(point.cycle), { raw: point.raw, reported: point.reported })
  }
  for (const item of forecast.fit ?? []) row(item.cycle).fit = item.fit
  for (const item of forecast.projection ?? []) {
    Object.assign(row(item.cycle), { projected: item.soh, band: [item.lower, item.upper] })
  }
  return [...rows.values()].sort((a, b) => a.cycle - b.cycle)
}

function describeBand(forecast) {
  const band = forecast.band
  if (!band) return { value: '--', detail: '' }
  const pts = formatValue(band.halfWidthPts, 2)
  const percent = formatValue(band.halfWidthPercent, 2)
  if (band.kind === 'assumed') {
    return { value: `±${pts} pts`, detail: `±${percent}% · assumed ±5% until about 8 scored cycles allow a real accuracy check` }
  }
  return {
    value: `±${pts} pts`,
    detail: `±${percent}% · 90th-percentile miss of ${band.backtest.samples} forecasts checked against the SOH measured afterwards`,
  }
}

export default function ForecastPanel({ forecast, ratedCapacityAh, measuredCapacityAh, batteryName }) {
  const status = forecast?.status ?? 'no-cycles'

  if (status !== 'ready') {
    return (
      <div className="forecast-card" aria-label={`${batteryName} SOH forecast`}>
        <div>
          <p className="eyebrow">SOH FORECAST</p>
          <h4>Waiting for enough cycles</h4>
          <p className="forecast-sub">
            {status === 'no-cycles'
              ? 'No scored discharge cycle yet. A cycle is scored when the battery discharges at least 8 points of SOC for 15 minutes or more and then rests (Switching / System off) so its voltage can be read.'
              : `${forecast.cycleCount} scored cycle${forecast.cycleCount === 1 ? '' : 's'} so far. A trend line needs at least 3.`}
          </p>
        </div>
        {forecast?.points?.length > 0 && (
          <div className="forecast-stats">
            <Stat label="Latest SOH" value={`${formatValue(forecast.latestSoh, 2)}%`} detail="Relative to this battery's first scored cycle" />
          </div>
        )}
      </div>
    )
  }

  const rows = buildChartRows(forecast)
  const values = rows.flatMap((item) => [item.raw, item.reported, item.fit, item.projected, item.band?.[0], item.band?.[1]]).filter(Number.isFinite)
  const yMin = Math.floor(Math.min(...values, forecast.threshold) - 2)
  const yMax = Math.ceil(Math.max(...values, 100) + 1)
  const band = describeBand(forecast)
  const toThreshold = forecast.toThreshold
  const test = forecast.band.backtest

  return (
    <div className="forecast-card" aria-label={`${batteryName} SOH forecast`}>
      <div>
        <p className="eyebrow">SOH FORECAST · PER CYCLE</p>
        <h4>{batteryName}: next cycle {formatValue(forecast.next.soh, 2)}% (range {formatValue(forecast.next.lower, 2)}–{formatValue(forecast.next.upper, 2)}%)</h4>
        <p className="forecast-sub">
          Straight-line fit through {forecast.cycleCount} scored cycles. SOH is calculated once per completed cycle from
          capacity = average load × hours ÷ ((100 − SOC final) ÷ 100), compared with this battery&apos;s first scored cycle.
        </p>
      </div>

      <div className="forecast-stats">
        <Stat label="Latest SOH" value={`${formatValue(forecast.latestSoh, 2)}%`} detail={Number.isFinite(measuredCapacityAh) ? `${formatValue(measuredCapacityAh, 1)} Ah measured of ${formatValue(ratedCapacityAh, 1)} Ah rated` : undefined} />
        <Stat label="Fade per cycle" value={`${formatValue(forecast.slopePerCycle, 3)} pts`} detail={`Fit quality R² ${formatValue(forecast.r2, 2)}`} />
        <Stat label="Forecast error range" value={band.value} detail={band.detail} />
        {test && <Stat label="Backtest accuracy" value={`${formatValue(test.maePts, 2)} pts`} detail={`mean miss · ${formatValue(test.mapePercent, 2)}% of SOH · ${formatValue(test.withinFivePts, 0)}% of forecasts within 5 pts`} />}
        {toThreshold
          ? <Stat
              label={`Cycles until ${forecast.threshold}% SOH`}
              value={`${toThreshold.expected - forecast.points[forecast.points.length - 1].cycle}`}
              detail={`Cycle ${toThreshold.earliest} (earliest) · ${toThreshold.expected} (expected) · ${toThreshold.latest} (latest)${Number.isFinite(toThreshold.daysExpected) ? ` · about ${formatValue(toThreshold.daysExpected, 0)} days at ${formatValue(toThreshold.cyclesPerDay, 2)} cycles/day` : ''}`}
            />
          : <Stat label={`Cycles until ${forecast.threshold}% SOH`} value="--" detail="SOH is not trending down yet" />}
      </div>

      <div className="forecast-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 2, left: 0 }}>
            <CartesianGrid stroke="#e7ece9" vertical={false} />
            <XAxis dataKey="cycle" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} tick={{ fill: '#74827c', fontSize: 10 }} tickLine={false} axisLine={false} label={{ value: 'Scored cycle', position: 'insideBottomRight', offset: -2, fontSize: 10, fill: '#74827c' }} />
            <YAxis width={46} domain={[yMin, yMax]} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} tick={{ fill: '#74827c', fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip
              labelFormatter={(value) => `Cycle ${value}`}
              formatter={(value, name) => (Array.isArray(value)
                ? [`${formatValue(value[0], 2)}–${formatValue(value[1], 2)}%`, name]
                : [`${formatValue(value, 2)}%`, name])}
              contentStyle={{ border: '1px solid #dce3df', borderRadius: 5, fontSize: 12 }}
            />
            <ReferenceLine y={forecast.threshold} stroke="#b84738" strokeDasharray="4 4" label={{ value: `${forecast.threshold}% end of life`, position: 'insideTopLeft', fontSize: 10, fill: '#b84738' }} />
            <Area dataKey="band" name="Forecast range" stroke="none" fill="#b06c29" fillOpacity={0.16} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="fit" name="Fitted line" stroke="#b06c29" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="projected" name="Forecast" stroke="#b06c29" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="reported" name="Reported SOH" stroke="#23785f" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="raw" name="Measured this cycle" stroke="none" dot={{ r: 3, fill: '#23785f' }} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="forecast-legend">
        <span><i style={{ borderColor: '#23785f' }} />Reported SOH (median of last 5 cycles, never rises)</span>
        <span><i style={{ borderColor: '#23785f', borderTopStyle: 'dotted' }} />Measured this cycle</span>
        <span><i style={{ borderColor: '#b06c29', borderTopStyle: 'dashed' }} />Forecast with error range</span>
      </div>
    </div>
  )
}
