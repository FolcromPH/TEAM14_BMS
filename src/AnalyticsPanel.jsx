import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import './App.css'

const AnalyticsBatteryPanel = lazy(() => import('./AnalyticsBatteryPanel.jsx'))
const ANALYTICS_RANGES = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

export default function AnalyticsPanel() {
  const [leftBatteryId, setLeftBatteryId] = useState('')
  const [rightBatteryId, setRightBatteryId] = useState('')
  const [range, setRange] = useState('1h')
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let stopped = false
    const controller = new AbortController()

    async function load() {
      try {
        const params = new URLSearchParams({ leftBatteryId, rightBatteryId, range })
        const response = await fetch(`/api/analytics?${params}`, { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load battery analytics')
        if (stopped) return
        setAnalytics(result)
        setLeftBatteryId((current) => current || String(result.selectedIdentityIds.left || ''))
        setRightBatteryId((current) => current || String(result.selectedIdentityIds.right || ''))
        setError('')
      } catch (requestError) {
        if (stopped || requestError.name === 'AbortError') return
        setError(requestError.message || 'Could not load battery analytics')
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    refreshWhenVisible()
    const interval = window.setInterval(refreshWhenVisible, 300000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      stopped = true
      controller.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refreshKey, leftBatteryId, rightBatteryId, range])

  function refresh() {
    setLoading(true)
    setRefreshKey((key) => key + 1)
  }

  const noReadings = !loading && analytics?.sampleCount === 0
  const identities = analytics?.batteryIdentities ?? []
  const comparisons = analytics?.comparisons ?? {}
  const graphSelections = [
    { side: 'left', identityId: leftBatteryId, data: comparisons.left },
    { side: 'right', identityId: rightBatteryId, data: comparisons.right },
  ]

  return (
    <section className="analytics-view" aria-labelledby="analytics-title">
      <div className="section-heading analytics-heading">
        <div>
          <p className="eyebrow">DISCHARGE &amp; BATTERY HEALTH</p>
          <h2 id="analytics-title">Battery analytics</h2>
        </div>
        <span className="analytics-sample-count">
          <Activity size={15} />
          {loading ? 'Updating analysis' : `${analytics?.sampleCount?.toLocaleString() ?? 0} time buckets`}
        </span>
      </div>

      <div className="analytics-toolbar">
        <label className="history-select-field">
          <span>Analysis period</span>
          <select className="battery-history-filter" value={range} onChange={(event) => setRange(event.target.value)}>
            {ANALYTICS_RANGES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="history-select-field">
          <span>Left graph</span>
          <select className="battery-history-filter" value={leftBatteryId} onChange={(event) => setLeftBatteryId(event.target.value)}>
            {identities.map((identity) => <option value={identity.id} key={identity.id}>{identity.name}{identity.active ? ` · Slot ${identity.slot}` : ` · Previous #${identity.id}`}</option>)}
          </select>
        </label>
        <label className="history-select-field">
          <span>Right graph</span>
          <select className="battery-history-filter" value={rightBatteryId} onChange={(event) => setRightBatteryId(event.target.value)}>
            {identities.map((identity) => <option value={identity.id} key={identity.id}>{identity.name}{identity.active ? ` · Slot ${identity.slot}` : ` · Previous #${identity.id}`}</option>)}
          </select>
        </label>
        <button className="icon-button" type="button" title="Refresh analytics" aria-label="Refresh analytics" onClick={refresh}>
          <RefreshCw size={17} />
        </button>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {noReadings && <div className="analytics-empty">No database readings in this range.</div>}

      {graphSelections.some((selection) => selection.data) && (
        <>
          <div className="analytics-battery-grid">
            {graphSelections.map(({ side, identityId, data }, graphIndex) => (
              data && <Suspense fallback={<div className="analytics-panel-loading">Loading battery analysis...</div>} key={`${side}-${identityId}`}>
                <AnalyticsBatteryPanel
                  index={graphIndex + 1}
                  batterySlot={data.slot}
                  batteryName={data.name}
                  analytics={data.analytics}
                  series={data.series}
                  ratedCapacityAh={data.ratedCapacityAh}
                  rangeLabel={ANALYTICS_RANGES.find((item) => item.value === range)?.label.toLowerCase() ?? 'last hour'}
                />
              </Suspense>
            ))}
          </div>
          <p className="analytics-method-note">
            Drain is the net SOC decrease across valid readings in the selected period. Estimates are withheld until at least 0.1 percentage points of decline are observed to avoid extrapolating sensor drift. When the firmware does not send BMS-reported SOC, the Worker estimates SOC by integrating INA current against rated capacity, so the 1% timing is an estimate. A battery BMS with SOC output gives a more reliable trend.
          </p>
        </>
      )}
    </section>
  )
}
