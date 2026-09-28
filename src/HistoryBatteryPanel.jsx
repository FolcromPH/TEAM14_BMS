import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

function formatValue(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue.toFixed(decimals) : '--'
}

function Metric({ label, value, unit, decimals = 2 }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">
        {formatValue(value, decimals)}
        <small>{unit}</small>
      </span>
    </div>
  )
}

export default function HistoryBatteryPanel({ index, latest, series, metric, range, batteryName }) {
  const battery = latest?.[`battery${index}`]
  const dataKey = `battery${index}${metric.key}`
  const color = index === 1 ? '#23785f' : '#b06c29'
  const status = battery?.connected === true
    ? 'ONLINE'
    : battery?.connected === false
      ? 'INA NOT FOUND'
      : 'NO DATA'

  return (
    <section className="history-battery" aria-labelledby={`history-battery-${index}`}>
      <div className="history-panel-heading">
        <div>
          <p className="eyebrow">D1 HISTORY</p>
          <h3 id={`history-battery-${index}`}>{batteryName}</h3>
        </div>
        <span className={`status-pill ${status === 'ONLINE' ? 'status-online' : ''}`}>
          {status}
        </span>
      </div>

      <div className="history-metrics">
        <Metric label="Voltage" value={battery?.voltage} unit="V" />
        <Metric label="Current" value={battery?.current} unit="A" />
        <Metric label="Power" value={battery?.power} unit="W" />
        <Metric label="Temperature" value={battery?.temperature} unit="°C" decimals={1} />
        <Metric label="State of charge" value={battery?.soc} unit="%" decimals={1} />
        <Metric label="State of health" value={battery?.soh} unit="%" decimals={1} />
      </div>

      <div className="history-chart-heading">
        <span>{metric.label} trend</span>
        <span>{metric.unit}</span>
      </div>
      {series.length > 0 ? (
        <div className="history-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="#e7ece9" vertical={false} />
              <XAxis
                dataKey="timestamp_ms"
                tickFormatter={(value) => range === '7d'
                  ? new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })
                  : new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                minTickGap={34}
                tick={{ fill: '#74827c', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                width={52}
                tickFormatter={(value) => Number(value).toFixed(metric.decimals)}
                tick={{ fill: '#74827c', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(value) => new Date(value).toLocaleString()}
                formatter={(value) => [`${formatValue(value, metric.decimals)} ${metric.unit}`, metric.label]}
                contentStyle={{ border: '1px solid #dce3df', borderRadius: 5, fontSize: 12 }}
              />
              <Line
                type="monotone"
                dataKey={dataKey}
                name={metric.label}
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="history-chart-empty">No readings in this time range</div>
      )}
    </section>
  )
}