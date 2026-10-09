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
import { useEffect, useState } from 'react'
import './sohForecast.css'

function formatValue(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue.toFixed(decimals) : '--'
}

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
    return { value: `±${pts} pts`, detail: `±${percent}% · assumed ±5% until about 8 cycles allow a real accuracy check` }
  }
  return {
    value: `±${pts} pts`,
    detail: `±${percent}% · 90th-percentile miss of ${band.backtest.samples} forecasts checked against the SOH measured afterwards`,
  }
}

function ForecastView({ forecast, ratedCapacityAh, measuredCapacityAh, batteryName }) {
  const status = forecast?.status ?? 'no-cycles'

  if (status !== 'ready') {
    return (
      <div className="forecast-card" aria-label={`${batteryName} SOH forecast`}>
        <div>
          <p className="eyebrow">SOH FORECAST</p>
          <h4>Waiting for enough cycles</h4>
          <p className="forecast-sub">
            {status === 'no-cycles'
              ? 'No change of the stored SOH has been recorded yet. Each time the SOH value changes (once per completed cycle) it counts as one cycle for this forecast.'
              : `${forecast.cycleCount} cycle${forecast.cycleCount === 1 ? '' : 's'} so far. A trend line needs at least 3.`}
          </p>
        </div>
        {forecast?.points?.length > 0 && (
          <div className="forecast-stats">
            <Stat label="Latest SOH" value={`${formatValue(forecast.latestSoh, 2)}%`} detail="As stored in the database" />
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
          Straight-line fit through {forecast.cycleCount} cycles. A cycle is one change of the SOH value stored in the
          database; the error range is checked against the SOH that was then actually recorded.
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
            <Line dataKey="raw" name="Recorded for that cycle" stroke="none" dot={{ r: 3, fill: '#23785f' }} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="forecast-legend">
        <span><i style={{ borderColor: '#23785f' }} />Stored SOH per cycle</span>
        <span><i style={{ borderColor: '#23785f', borderTopStyle: 'dotted' }} />Recorded for that cycle</span>
        <span><i style={{ borderColor: '#b06c29', borderTopStyle: 'dashed' }} />Forecast with error range</span>
      </div>
    </div>
  )
}

// Drop-in panel: picks a saved battery, fetches /api/forecast and draws the result.
export default function SohForecastPanel() {
  const [batteryId, setBatteryId] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stopped = false
    async function load() {
      try {
        const response = await fetch(`/api/forecast?${new URLSearchParams(batteryId ? { batteryId } : {})}`)
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load the forecast')
        if (stopped) return
        setData(result)
        setError('')
        setBatteryId((current) => current || String(result.identity?.id ?? ''))
      } catch (requestError) {
        if (!stopped) setError(requestError.message || 'Could not load the forecast')
      } finally {
        if (!stopped) setLoading(false)
      }
    }
    load()
    const interval = window.setInterval(load, 300000)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [batteryId])

  const identities = data?.batteryIdentities ?? []
  return (
    <section className="forecast-addon" aria-labelledby="forecast-addon-title">
      <div className="forecast-addon-heading">
        <div>
          <p className="eyebrow">SOH FORECAST</p>
          <h2 id="forecast-addon-title">Battery health forecast</h2>
        </div>
        <label className="forecast-addon-select">
          <span>Battery</span>
          <select value={batteryId} onChange={(event) => { setLoading(true); setBatteryId(event.target.value) }}>
            {identities.map((identity) => (
              <option value={identity.id} key={identity.id}>
                {identity.name}{identity.active ? ` · Slot ${identity.slot}` : ` · Previous #${identity.id}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="forecast-empty" role="alert">{error}</p>}
      {loading && !data && <p className="forecast-empty">Loading forecast...</p>}
      {data?.identity && (
        <ForecastView
          forecast={data.forecast}
          ratedCapacityAh={data.identity.ratedCapacityAh}
          batteryName={data.identity.name}
        />
      )}
      {data && !data.identity && <p className="forecast-empty">No saved batteries yet.</p>}
    </section>
  )
}
