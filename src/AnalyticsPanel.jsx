import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import './App.css'

const AnalyticsBatteryPanel = lazy(() => import('./AnalyticsBatteryPanel.jsx'))

export default function AnalyticsPanel() {
  const [leftBattery, setLeftBattery] = useState('1')
  const [rightBattery, setRightBattery] = useState('2')
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let stopped = false

    async function load() {
      try {
        const response = await fetch('/api/analytics')
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load battery analytics')
        if (stopped) return
        setAnalytics(result)
        setError('')
      } catch (requestError) {
        if (stopped) return
        setError(requestError.message || 'Could not load battery analytics')
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    load()
    const interval = window.setInterval(load, 60000)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [refreshKey])

  function refresh() {
    setLoading(true)
    setRefreshKey((key) => key + 1)
  }

  const noReadings = !loading && analytics?.sampleCount === 0
  const batteryNames = Object.fromEntries((analytics?.batteries ?? []).map((battery) => [battery.slot, battery.name]))
  const graphSlots = [Number(leftBattery), Number(rightBattery)]

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
        <span className="analytics-period-label">Rolling 24 hours</span>
        <label className="history-select-field">
          <span>Left graph</span>
          <select className="battery-history-filter" value={leftBattery} onChange={(event) => setLeftBattery(event.target.value)}>
            {[1, 2].map((slot) => <option value={slot} key={slot}>{batteryNames[slot] || `Battery ${slot}`}</option>)}
          </select>
        </label>
        <label className="history-select-field">
          <span>Right graph</span>
          <select className="battery-history-filter" value={rightBattery} onChange={(event) => setRightBattery(event.target.value)}>
            {[1, 2].map((slot) => <option value={slot} key={slot}>{batteryNames[slot] || `Battery ${slot}`}</option>)}
          </select>
        </label>
        <button className="icon-button" type="button" title="Refresh analytics" aria-label="Refresh analytics" onClick={refresh}>
          <RefreshCw size={17} />
        </button>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {noReadings && <div className="analytics-empty">No database readings in this range.</div>}

      {analytics?.sampleCount > 0 && (
        <>
          <div className="analytics-battery-grid">
            {graphSlots.map((index, graphIndex) => (
              <Suspense fallback={<div className="analytics-panel-loading">Loading battery analysis...</div>} key={`${graphIndex}-${index}`}>
                <AnalyticsBatteryPanel
                  index={index}
                  batteryName={batteryNames[index] || `Battery ${index}`}
                  analytics={analytics[`battery${index}`]}
                  series={analytics.series}
                  ratedCapacityAh={analytics.ratedCapacityAh[`battery${index}`]}
                />
              </Suspense>
            ))}
          </div>
          <p className="analytics-method-note">
            Drain is the net SOC decrease across valid readings in the last 24 hours. When the firmware does not send BMS-reported SOC, the Worker estimates SOC by integrating INA current against rated capacity, so the 1% timing is an estimate. A battery BMS with SOC output gives a more reliable trend.
          </p>
        </>
      )}
    </section>
  )
}
