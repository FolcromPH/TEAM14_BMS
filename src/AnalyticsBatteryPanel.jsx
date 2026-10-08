import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BatteryCharging } from 'lucide-react'

function format(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--'
}

function AnalyticsMetric({ label, value, unit, detail }) {
  return (
    <div className="analytics-metric">
      <span className="metric-label">{label}</span>
      <strong>{value}<small>{unit}</small></strong>
      {detail && <span className="analytics-metric-detail">{detail}</span>}
    </div>
  )
}

export default function AnalyticsBatteryPanel({ index, batterySlot, batteryName, analytics, series, ratedCapacityAh, rangeLabel }) {
  const color = index === 1 ? '#23785f' : '#b06c29'
  const socKey = `battery${batterySlot}Soc`
  const hasSocSamples = series.some((point) => Number.isFinite(point[socKey]))
  const hasSohForecast = analytics.predictedSohDropNextCycle !== null
  const nextSoh = hasSohForecast && analytics.latestSoh !== null
    ? Math.max(0, analytics.latestSoh - analytics.predictedSohDropNextCycle)
    : null

  return (
    <section className="analytics-battery" aria-labelledby={`analytics-battery-${index}`}>
      <div className="analytics-battery-heading">
        <span className={`battery-symbol battery-symbol-${index}`}><BatteryCharging size={20} /></span>
        <div>
          <p className="eyebrow">{batteryName.toUpperCase()} / {format(ratedCapacityAh, 0)} AH RATED</p>
          <h3 id={`analytics-battery-${index}`}>Discharge profile</h3>
        </div>
        <span className={`status-pill ${hasSocSamples ? 'status-online' : ''}`}>
          {hasSocSamples ? 'SOC SAMPLED' : 'NO SOC DATA'}
        </span>
      </div>

      <div className="analytics-metric-grid">
        <AnalyticsMetric
          label="Average discharge current"
          value={format(analytics.averageDischargeA)}
          unit=" A"
          detail={hasSocSamples
            ? batterySlot === 1 ? 'System battery · all modes' : 'While Battery 1 is charging'
            : 'No connected-sensor samples'}
        />
        <AnalyticsMetric
          label="Estimated drain rate"
          value={format(analytics.drainPercentPerHour)}
          unit=" %/h"
          detail={analytics.drainPercentPerHour === null
            ? !hasSocSamples
              ? 'No connected-sensor data'
              : analytics.socDeclinePercent > 0
                ? 'SOC decline too small to estimate reliably'
                : `No net SOC decline observed in ${rangeLabel}`
            : `Net decline over ${format(analytics.socObservationHours, 1)} observed hours`}
        />
        <AnalyticsMetric
          label="Time per 1% drop"
          value={format(analytics.minutesPerPercentDrop, 1)}
          unit=" min"
          detail="Based on observed SOC decline"
        />
        <AnalyticsMetric
          label="Estimated time remaining"
          value={format(analytics.hoursToEmpty, 1)}
          unit=" h"
          detail={Number.isFinite(analytics.latestSoc) ? `${format(analytics.latestSoc, 1)}% estimated charge` : 'Charge estimate unavailable'}
        />
        <AnalyticsMetric
          label="Completed charge cycles"
          value={String(analytics.completedChargeCycles)}
          unit=""
          detail={`${analytics.measuredSohCycleCount} with measured SOH at both ends`}
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
              <XAxis
                dataKey="timestamp_ms"
                tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                minTickGap={34}
                tick={{ fill: '#74827c', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                width={46}
                tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                tick={{ fill: '#74827c', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(value) => new Date(value).toLocaleString()}
                formatter={(value) => [`${format(value, 1)}%`, 'State of charge']}
                contentStyle={{ border: '1px solid #dce3df', borderRadius: 5, fontSize: 12 }}
              />
              <Line
                type="monotone"
                dataKey={socKey}
                name="State of charge"
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="analytics-chart-empty">Discharge trend unavailable until this INA is connected during load.</div>
      )}

      <div className="soh-forecast">
        <div>
          <p className="eyebrow">NEXT CHARGE CYCLE</p>
          <h4>SOH decline forecast</h4>
          <span>
            {hasSohForecast
              ? `Based on ${analytics.measuredSohCycleCount} measured completed cycle${analytics.measuredSohCycleCount === 1 ? '' : 's'} (${analytics.sohForecastConfidence} confidence)`
              : 'Unavailable: no completed cycles have at least two measured SOH readings.'}
          </span>
        </div>
        <div className="soh-forecast-values">
          <strong>{hasSohForecast ? `${format(analytics.predictedSohDropNextCycle, 3)} pp` : '--'}</strong>
          <span>predicted drop</span>
          <small>{nextSoh !== null ? `${format(nextSoh, 2)}% estimated after cycle` : 'Current measured SOH unavailable'}</small>
        </div>
      </div>
    </section>
  )
}
