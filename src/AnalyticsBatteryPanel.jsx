import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BatteryCharging, Download } from 'lucide-react'
import ForecastPanel from './ForecastPanel.jsx'
import { formatValue, timeAxisProps } from './chartUtils.js'

function AnalyticsMetric({ label, value, unit, detail }) {
  return (
    <div className="analytics-metric">
      <span className="metric-label">{label}</span>
      <strong>{value}<small>{unit}</small></strong>
      {detail && <span className="analytics-metric-detail">{detail}</span>}
    </div>
  )
}

const SOURCE_LABELS = { ocv: 'rest voltage', cc: 'coulomb only', csv: 'imported' }

function drainDetail(analytics, hasSocSamples, rangeLabel) {
  if (analytics.drainPercentPerHour === null) {
    if (!hasSocSamples) return 'No connected-sensor data'
    return `No discharge observed in ${rangeLabel}`
  }
  const hours = formatValue(analytics.socObservationHours, 1)
  return analytics.drainSource === 'cycles'
    ? `From completed cycles: ${hours} h of discharge`
    : analytics.drainSource === 'soc'
      ? `SOC decline over ${hours} h of discharge`
      : `Average load ÷ rated capacity (no SOC decline measured yet)`
}

export default function AnalyticsBatteryPanel({
  index, batterySlot, identityId, batteryName, analytics, series, forecast, cycles,
  ratedCapacityAh, measuredCapacityAh, rangeLabel, startMs, endMs,
}) {
  const color = index === 1 ? '#23785f' : '#b06c29'
  const socKey = `battery${batterySlot}Soc`
  const hasSocSamples = series.some((point) => Number.isFinite(point[socKey]))

  return (
    <section className="analytics-battery" aria-labelledby={`analytics-battery-${index}`}>
      <div className="analytics-battery-heading">
        <span className={`battery-symbol battery-symbol-${index}`}><BatteryCharging size={20} /></span>
        <div>
          <p className="eyebrow">{batteryName.toUpperCase()} / {formatValue(ratedCapacityAh, 1)} AH RATED</p>
          <h3 id={`analytics-battery-${index}`}>Discharge profile</h3>
        </div>
        <span className={`status-pill ${hasSocSamples ? 'status-online' : ''}`}>
          {hasSocSamples ? 'SOC SAMPLED' : 'NO SOC DATA'}
        </span>
      </div>

      <div className="analytics-metric-grid">
        <AnalyticsMetric
          label="Average discharge current"
          value={formatValue(analytics.averageDischargeA)}
          unit=" A"
          detail={batterySlot === 1
            ? 'System battery: also powers the ESP32 in every mode'
            : 'While Battery 1 is charging'}
        />
        <AnalyticsMetric
          label="Estimated drain rate"
          value={formatValue(analytics.drainPercentPerHour)}
          unit=" %/h"
          detail={drainDetail(analytics, hasSocSamples, rangeLabel)}
        />
        <AnalyticsMetric
          label="Time per 1% drop"
          value={formatValue(analytics.minutesPerPercentDrop, 1)}
          unit=" min"
          detail="From the drain rate above"
        />
        <AnalyticsMetric
          label="Estimated time remaining"
          value={formatValue(analytics.hoursToEmpty, 1)}
          unit=" h"
          detail={Number.isFinite(analytics.latestSoc) ? `${formatValue(analytics.latestSoc, 1)}% charge now` : 'Charge estimate unavailable'}
        />
        <AnalyticsMetric
          label="Scored cycles"
          value={String(analytics.completedCycles ?? 0)}
          unit=""
          detail={`${analytics.loggedCycles ?? 0} discharge cycles logged in total`}
        />
      </div>

      <div className="analytics-chart-title">
        <span>State of charge · {rangeLabel}</span>
        <span>%</span>
      </div>
      {hasSocSamples ? (
        <div className="analytics-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="#e7ece9" vertical={false} />
              <XAxis dataKey="timestamp_ms" {...timeAxisProps(startMs, endMs)} />
              <YAxis
                width={46}
                domain={[0, 100]}
                tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                tick={{ fill: '#74827c', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(value) => new Date(value).toLocaleString()}
                formatter={(value) => [`${formatValue(value, 1)}%`, 'State of charge']}
                contentStyle={{ border: '1px solid #dce3df', borderRadius: 5, fontSize: 12 }}
              />
              <Line
                type="linear"
                dataKey={socKey}
                name="State of charge"
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="analytics-chart-empty">No SOC readings for this battery in {rangeLabel}.</div>
      )}

      <ForecastPanel
        forecast={forecast}
        ratedCapacityAh={ratedCapacityAh}
        measuredCapacityAh={measuredCapacityAh}
        batteryName={batteryName}
      />

      {cycles?.length > 0 && (
        <details className="cycle-details">
          <summary>Cycle log ({cycles.length} most recent)</summary>
          <div className="cycle-table-scroll">
            <table className="cycle-table">
              <thead>
                <tr><th>Cycle</th><th>Ended</th><th>Hours</th><th>Load A</th><th>DoD %</th><th>SOC final</th><th>Capacity Ah</th><th>SOH %</th></tr>
              </thead>
              <tbody>
                {[...cycles].reverse().map((cycle) => (
                  <tr key={`${cycle.startedAtMs}`}>
                    <td>{cycle.number ?? 'not scored'}</td>
                    <td>{new Date(cycle.endedAtMs).toLocaleString()}</td>
                    <td>{formatValue(cycle.hours, 2)}</td>
                    <td>{formatValue(cycle.avgLoadA, 2)}</td>
                    <td>{formatValue(cycle.dodPercent, 1)}</td>
                    <td>{formatValue(cycle.socFinal, 1)} ({SOURCE_LABELS[cycle.source] ?? cycle.source})</td>
                    <td>{formatValue(cycle.capacityAh, 2)}</td>
                    <td>{formatValue(cycle.sohRaw, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <a className="inventory-cancel" href={`/api/cycles.csv?batteryId=${identityId}`} download><Download size={14} /> Download cycle log (CSV)</a>
        </details>
      )}
    </section>
  )
}
