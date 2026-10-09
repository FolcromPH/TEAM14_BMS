// Shared chart helpers, so every graph labels its time axis the same way.
const DAY = 86400000

export function timeAxisProps(startMs, endMs) {
  const hasRange = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
  const span = hasRange ? endMs - startMs : 0
  return {
    type: 'number',
    scale: 'time',
    domain: hasRange ? [startMs, endMs] : ['dataMin', 'dataMax'],
    allowDataOverflow: true,
    tickFormatter: (value) => formatTick(value, span),
    minTickGap: 40,
    tick: { fill: '#74827c', fontSize: 10 },
    tickLine: false,
    axisLine: false,
  }
}

export function formatTick(value, spanMs) {
  const date = new Date(value)
  if (spanMs >= 2 * DAY) return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (spanMs > DAY) return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatValue(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue.toFixed(decimals) : '--'
}

// Percentages (SOC, SOH) always sit on a fixed 0-100 axis, so a flat line is not stretched to look dramatic.
export function percentDomain(values, padding = 2) {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return [0, 100]
  return [Math.max(0, Math.floor(Math.min(...finite) - padding)), Math.min(100, Math.ceil(Math.max(...finite) + padding))]
}

export function statusClass(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
