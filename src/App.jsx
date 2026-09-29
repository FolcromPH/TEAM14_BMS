import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Activity,
  ArrowRightLeft,
  BatteryCharging,
  Clock3,
  ClipboardCheck,
  Database,
  Power,
  RefreshCw,
  TriangleAlert,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import './App.css'

const HistoryBatteryPanel = lazy(() => import('./HistoryBatteryPanel.jsx'))
const AnalyticsPanel = lazy(() => import('./AnalyticsPanel.jsx'))
const BatteryInventory = lazy(() => import('./BatteryInventory.jsx'))

const HISTORY_RANGES = [
  { label: '1 hour', value: '1h' },
  { label: '6 hours', value: '6h' },
  { label: '24 hours', value: '24h' },
  { label: '7 days', value: '7d' },
]

const HISTORY_METRICS = [
  { key: 'Power', label: 'Power', unit: 'W', decimals: 2 },
  { key: 'Current', label: 'Current', unit: 'A', decimals: 2 },
  { key: 'Voltage', label: 'Voltage', unit: 'V', decimals: 2 },
  { key: 'Temperature', label: 'Temperature', unit: '°C', decimals: 1 },
  { key: 'Soc', label: 'Charge', unit: '%', decimals: 1 },
]

function getHardwareAlerts(reading) {
  if (!reading) return []

  const alerts = []
  if (reading.system?.brownoutDetected) {
    alerts.push({
      key: 'brownout',
      title: 'ESP32 brownout',
      message: 'The ESP32 restarted after its supply voltage dropped too low. Check the power supply and wiring.',
    })
  }
  if (reading.battery1?.connected === false) {
    alerts.push({
      key: 'ina1',
      title: 'Battery 1 INA260 not found',
      message: 'Check the sensor power, I2C wiring, and address 0x40.',
    })
  }
  if (reading.battery2?.connected === false) {
    alerts.push({
      key: 'ina2',
      title: 'Battery 2 INA260 not found',
      message: 'Check the sensor power, I2C wiring, and address 0x41.',
    })
  }
  return alerts
}

function formatValue(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue.toFixed(decimals) : '--'
}

function batteryStatus(battery, system, index) {
  if (!system) return 'OFFLINE'
  if (system?.switching) return 'SWITCHING'
  if (battery?.connected === false) return 'INA NOT FOUND'
  if (battery?.status) return String(battery.status).toUpperCase()
  if (system?.mode === 'Battery1 Charging') return index === 1 ? 'CHARGING' : 'OUTPUT'
  if (system?.mode === 'Battery2 Charging') return index === 2 ? 'CHARGING' : 'OUTPUT'
  if (system?.mode === 'SYSTEM OFF') return 'OFF'
  return 'STANDBY'
}

function Metric({ label, value, unit, decimals = 2, emphasis = false }) {
  return (
    <div className={`metric${emphasis ? ' metric-emphasis' : ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">
        {formatValue(value, decimals)}
        <small>{unit}</small>
      </span>
    </div>
  )
}

function BatteryPanel({ index, battery, health, system, batteryName }) {
  const status = batteryStatus(battery, system, index)
  const hasSignal = battery && Object.values(battery).some((value) => value !== null && value !== undefined)

  return (
    <section className="battery-panel" aria-labelledby={`battery-${index}-title`}>
      <div className="panel-heading">
        <div className="battery-name">
          <span className={`battery-symbol battery-symbol-${index}`}><BatteryCharging size={20} /></span>
          <div>
            <p className="eyebrow">ENERGY STORAGE</p>
            <h2 id={`battery-${index}-title`}>{batteryName || `Battery ${index}`}</h2>
          </div>
        </div>
        <span className={`status-pill status-${status.toLowerCase()}`}>{status}</span>
      </div>

      <div className="metric-grid">
        <Metric label="Voltage" value={battery?.voltage} unit="V" />
        <Metric label="Current" value={battery?.current} unit="A" />
        <Metric label="Power" value={battery?.power} unit="W" />
        <Metric label="Temperature" value={battery?.temperature} unit="°C" decimals={1} />
      </div>

      <div className="health-row">
        <Metric label="State of charge" value={hasSignal ? health?.soc : null} unit="%" decimals={1} emphasis />
        <Metric label="State of health" value={hasSignal ? health?.soh : null} unit="%" decimals={1} emphasis />
      </div>
    </section>
  )
}

function DatabaseReader() {
  const [range, setRange] = useState('24h')
  const [metricKey, setMetricKey] = useState('Power')
  const [leftBatteryId, setLeftBatteryId] = useState('')
  const [rightBatteryId, setRightBatteryId] = useState('')
  const [tableBatteryId, setTableBatteryId] = useState('')
  const [tableSortMode, setTableSortMode] = useState('latest')
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const identities = history?.batteryIdentities ?? []
  const tableIdentity = identities.find((identity) => String(identity.id) === tableBatteryId)
  const tableSlot = String(tableIdentity?.slot ?? 1)

  useEffect(() => {
    let stopped = false
    const tableSort = tableSortMode === 'latest' ? 'latest' : metricKey.toLowerCase()
    const tableOrder = tableSortMode === 'lowest' ? 'asc' : 'desc'

    async function loadHistory() {
      try {
        const params = new URLSearchParams({
          range,
          slot: tableSlot,
          sort: tableSort,
          order: tableOrder,
          leftBatteryId,
          rightBatteryId,
          batteryId: tableBatteryId,
        })
        const response = await fetch(`/api/readings?${params}`)
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not read database history')
        if (stopped) return
        setHistory(result)
        setLeftBatteryId((current) => current || String(result.selectedIdentityIds.left || ''))
        setRightBatteryId((current) => current || String(result.selectedIdentityIds.right || ''))
        setTableBatteryId((current) => current || String(result.selectedBatteryId || ''))
        setError('')
      } catch (requestError) {
        if (stopped) return
        setError(requestError.message || 'Could not read database history')
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    loadHistory()
    const interval = window.setInterval(loadHistory, 30000)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [range, refreshToken, tableBatteryId, tableSlot, tableSortMode, metricKey, leftBatteryId, rightBatteryId])

  const metric = HISTORY_METRICS.find((item) => item.key === metricKey) ?? HISTORY_METRICS[0]
  const sampleCount = history?.series?.reduce((total, point) => total + point.samples, 0) ?? 0
  const latest = history?.readings?.[0]
  const leftIdentity = identities.find((identity) => String(identity.id) === leftBatteryId)
  const rightIdentity = identities.find((identity) => String(identity.id) === rightBatteryId)
  const graphSelections = [
    { side: 'left', identity: leftIdentity, history: history?.identitySeries?.left },
    { side: 'right', identity: rightIdentity, history: history?.identitySeries?.right },
  ]
  const tableSortLabel = tableSortMode === 'latest'
    ? 'Latest readings'
    : `${tableSortMode === 'highest' ? 'Highest' : 'Lowest'} ${metric.label.toLowerCase()}`

  return (
    <section className="database-reader" aria-labelledby="database-reader-title">
      <div className="section-heading database-heading">
        <div>
          <p className="eyebrow">D1 TELEMETRY</p>
          <h2 id="database-reader-title">Database reader</h2>
        </div>
        <div className={`sheets-state ${history?.googleSheetsConfigured ? 'sheets-enabled' : ''}`} role="status">
          <span />Google Sheets {history?.googleSheetsConfigured ? 'sync enabled' : 'sync not configured'}
        </div>
      </div>

      <div className="history-toolbar">
        <div className="segmented-control" aria-label="History time range">
          {HISTORY_RANGES.map((item) => (
            <button
              className={range === item.value ? 'segment-active' : ''}
              type="button"
              key={item.value}
              aria-pressed={range === item.value}
              onClick={() => {
                setLoading(true)
                setRange(item.value)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="segmented-control metric-selector" aria-label="Graph metric">
          {HISTORY_METRICS.map((item) => (
            <button
              className={metricKey === item.key ? 'segment-active' : ''}
              type="button"
              key={item.key}
              aria-pressed={metricKey === item.key}
              onClick={() => setMetricKey(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
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
        <button
          className="icon-button history-refresh"
          type="button"
          title="Refresh database readings"
          aria-label="Refresh database readings"
          onClick={() => {
            setLoading(true)
            setRefreshToken((token) => token + 1)
          }}
        >
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="history-summary" aria-live="polite">
        <span><Database size={15} />{loading ? 'Loading D1 readings' : `${sampleCount.toLocaleString()} stored readings in range`}</span>
        <span>{history?.readings?.length ? `Latest: ${new Date(latest.timestamp).toLocaleString()}` : 'No stored readings'}</span>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      <Suspense fallback={<div className="history-graphs-loading">Loading graphs...</div>}>
        <div className="history-battery-grid">
          {graphSelections.map(({ side, identity, history: identityHistory }, graphIndex) => (
            <HistoryBatteryPanel
              index={graphIndex + 1}
              key={`${side}-${identity?.id ?? 'empty'}`}
              latest={identityHistory?.latest}
              series={identityHistory?.series ?? []}
              metric={metric}
              range={range}
              batteryName={identity?.name ?? 'Select a battery'}
            />
          ))}
        </div>
      </Suspense>

      <section className="reading-table-section" aria-labelledby="reading-table-title">
        <div className="reading-table-heading">
          <div>
            <h3 id="reading-table-title">{tableIdentity?.name || 'Battery'} · {tableSortLabel}</h3>
            <span>{tableSortMode === 'latest' ? 'Newest values in selected range' : `Sorted by ${metric.label.toLowerCase()} across selected range`}</span>
          </div>
          <div className="reading-table-controls">
            <label className="history-select-field">
              <span>Battery</span>
              <select className="battery-history-filter" value={tableBatteryId} onChange={(event) => setTableBatteryId(event.target.value)}>
                {identities.map((identity) => <option value={identity.id} key={identity.id}>{identity.name}{identity.active ? ` · Slot ${identity.slot}` : ` · Previous #${identity.id}`}</option>)}
              </select>
            </label>
            <label className="history-select-field">
              <span>Order</span>
              <select className="battery-history-filter" value={tableSortMode} onChange={(event) => setTableSortMode(event.target.value)}>
                <option value="latest">Latest first</option>
                <option value="highest">Highest first</option>
                <option value="lowest">Lowest first</option>
              </select>
            </label>
          </div>
        </div>
        <div className="reading-table-scroll">
          <table className="reading-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Battery</th>
                <th scope="col">Capture</th>
                <th scope="col">Mode</th>
                <th scope="col">Voltage</th>
                <th scope="col">Current</th>
                <th scope="col">Power</th>
                <th scope="col">Temperature</th>
              </tr>
            </thead>
            <tbody>
              {history?.readings?.length ? history.readings.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.timestamp).toLocaleString()}</td>
                  <td>{item[`battery${tableSlot}`].identityName || '--'}</td>
                  <td>{item.captureRequestId ? 'Requested' : '--'}</td>
                  <td>{item.mode || '--'}</td>
                  <td>{formatValue(item[`battery${tableSlot}`].voltage)}</td>
                  <td>{formatValue(item[`battery${tableSlot}`].current)}</td>
                  <td>{formatValue(item[`battery${tableSlot}`].power)}</td>
                  <td>{formatValue(item[`battery${tableSlot}`].temperature, 1)}</td>
                </tr>
              )) : (
                <tr><td className="reading-table-empty" colSpan={8}>No stored readings in this time range</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  )
}

function App() {
  const [reading, setReading] = useState(null)
  const [batterySpecs, setBatterySpecs] = useState([])
  const [health, setHealth] = useState(null)
  const [connection, setConnection] = useState('connecting')
  const [lastUpdate, setLastUpdate] = useState(null)
  const [error, setError] = useState('')
  const [busyMode, setBusyMode] = useState(null)
  const [message, setMessage] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [dismissedAlerts, setDismissedAlerts] = useState(() => new Set())
  const [activeTab, setActiveTab] = useState('overview')

  useEffect(() => {
    let stopped = false

    async function refreshDashboard() {
      try {
        const [readingResponse, healthResponse] = await Promise.all([
          fetch('/api/esp32'),
          fetch('/api/health'),
        ])
        const [readingResult, healthResult] = await Promise.all([
          readingResponse.json(),
          healthResponse.json(),
        ])

        if (stopped) return
        setBatterySpecs(readingResult.batteries ?? [])
        setHealth(healthResult)
        if (!readingResponse.ok || !readingResult.connected) {
          setReading(null)
          setConnection('disconnected')
          setError(readingResult.error || 'ESP32 is not responding')
          return
        }
        if (!healthResponse.ok) throw new Error(healthResult.error || 'Could not read battery health')

        const activeAlertKeys = new Set(getHardwareAlerts(readingResult).map((alert) => alert.key))
        setDismissedAlerts((current) => new Set(
          [...current].filter((key) => activeAlertKeys.has(key)),
        ))
        setReading(readingResult)
        setConnection('connected')
        setLastUpdate(new Date())
        setError('')
      } catch (requestError) {
        if (stopped) return
        setConnection('disconnected')
        setError(requestError.message || 'Could not reach the Worker API')
      }
    }

    refreshDashboard()
    const interval = window.setInterval(refreshDashboard, 5000)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [refreshToken])

  async function setMode(mode) {
    setBusyMode(mode)
    setMessage('')
    try {
      const response = await fetch(`/api/control/${mode}`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Command was rejected')
      setMessage('Command queued; ESP32 will apply it when it polls')
    } catch (requestError) {
      setMessage(requestError.message || 'Could not send command')
    } finally {
      setBusyMode(null)
    }
  }

  const wifi = reading?.wifi
  const visibleAlerts = getHardwareAlerts(reading).filter(
    (alert) => !dismissedAlerts.has(alert.key),
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><Zap size={21} fill="currentColor" /></span>
          <div>
            <p className="eyebrow">MICROGRID / BATTERY MANAGEMENT</p>
            <h1>Battery monitor</h1>
          </div>
        </div>
        <div className={`connection-state connection-${connection}`} role="status">
          {connection === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>{connection === 'connected' ? 'ESP32 online' : connection === 'connecting' ? 'Connecting' : 'ESP32 offline'}</span>
          <span className="connection-indicator" />
        </div>
      </header>

      <main className="dashboard">
        <nav className="dashboard-tabs" role="tablist" aria-label="Dashboard views">
          <button
            id="overview-tab"
            className={activeTab === 'overview' ? 'dashboard-tab tab-active' : 'dashboard-tab'}
            type="button"
            role="tab"
            aria-selected={activeTab === 'overview'}
            aria-controls="overview-panel"
            onClick={() => setActiveTab('overview')}
          >
            <ClipboardCheck size={16} />Overview
          </button>
          <button
            id="database-tab"
            className={activeTab === 'database' ? 'dashboard-tab tab-active' : 'dashboard-tab'}
            type="button"
            role="tab"
            aria-selected={activeTab === 'database'}
            aria-controls="database-panel"
            onClick={() => setActiveTab('database')}
          >
            <Database size={16} />Database reader
          </button>
          <button
            id="analytics-tab"
            className={activeTab === 'analytics' ? 'dashboard-tab tab-active' : 'dashboard-tab'}
            type="button"
            role="tab"
            aria-selected={activeTab === 'analytics'}
            aria-controls="analytics-panel"
            onClick={() => setActiveTab('analytics')}
          >
            <Activity size={16} />Analytics
          </button>
          <button
            id="batteries-tab"
            className={activeTab === 'batteries' ? 'dashboard-tab tab-active' : 'dashboard-tab'}
            type="button"
            role="tab"
            aria-selected={activeTab === 'batteries'}
            aria-controls="batteries-panel"
            onClick={() => setActiveTab('batteries')}
          >
            <BatteryCharging size={16} />Batteries
          </button>
        </nav>

        {activeTab === 'database' ? (
          <div id="database-panel" role="tabpanel" aria-labelledby="database-tab">
            <DatabaseReader />
          </div>
        ) : activeTab === 'analytics' ? (
          <div id="analytics-panel" role="tabpanel" aria-labelledby="analytics-tab">
            <Suspense fallback={<div className="history-graphs-loading">Loading analytics...</div>}>
              <AnalyticsPanel />
            </Suspense>
          </div>
        ) : activeTab === 'batteries' ? (
          <div id="batteries-panel" role="tabpanel" aria-labelledby="batteries-tab">
            <Suspense fallback={<div className="history-graphs-loading">Loading batteries...</div>}>
              <BatteryInventory />
            </Suspense>
          </div>
        ) : (
          <div id="overview-panel" role="tabpanel" aria-labelledby="overview-tab">
        <section className="overview-strip" aria-label="System overview">
          <div className="overview-item">
            <span className="overview-icon"><Activity size={18} /></span>
            <div><span className="overview-label">Operating mode</span><strong>{reading?.mode || 'Waiting for data'}</strong></div>
          </div>
          <div className="overview-item">
            <span className="overview-icon"><Wifi size={18} /></span>
            <div><span className="overview-label">ESP32 network</span><strong>{wifi?.ip || 'Not available'}{wifi?.rssi != null ? ` · ${wifi.rssi} dBm` : ''}</strong></div>
          </div>
          <div className="overview-item">
            <span className="overview-icon"><Clock3 size={18} /></span>
            <div><span className="overview-label">Last reading</span><strong>{lastUpdate ? lastUpdate.toLocaleTimeString() : '--'}</strong></div>
          </div>
        </section>

        {error && (
          <div className="notice notice-error" role="alert">
            <WifiOff size={17} />
            <span>{error}</span>
          </div>
        )}

        <div className="section-heading">
          <div>
            <p className="eyebrow">LIVE TELEMETRY</p>
            <h2>Battery status</h2>
          </div>
          <span className="sampling-label"><span /> 5 second sampling</span>
        </div>

        <div className="battery-grid">
          <BatteryPanel
            index={1}
            battery={reading?.battery1}
            health={health?.battery1}
            system={reading}
            batteryName={reading?.battery1?.identityName || batterySpecs.find((battery) => battery.slot === 1)?.name}
          />
          <BatteryPanel
            index={2}
            battery={reading?.battery2}
            health={health?.battery2}
            system={reading}
            batteryName={reading?.battery2?.identityName || batterySpecs.find((battery) => battery.slot === 2)?.name}
          />
        </div>

        <section className="control-section" aria-labelledby="control-title">
          <div className="section-heading control-heading">
            <div>
              <p className="eyebrow">ESP32 COMMANDS</p>
              <h2 id="control-title">System control</h2>
            </div>
            <button className="icon-button" type="button" title="Refresh readings" aria-label="Refresh readings" onClick={() => setRefreshToken((token) => token + 1)}>
              <RefreshCw size={17} />
            </button>
          </div>
          <div className="control-actions">
            <button className="control-button control-charge" type="button" disabled={busyMode !== null} onClick={() => setMode(1)}>
              <BatteryCharging size={19} /><span>Battery 1 charging</span>
            </button>
            <button className="control-button control-switch" type="button" disabled={busyMode !== null} onClick={() => setMode(2)}>
              <ArrowRightLeft size={19} /><span>Switch to battery 2</span>
            </button>
            <button className="control-button control-off" type="button" disabled={busyMode !== null} onClick={() => setMode(3)}>
              <Power size={19} /><span>System off</span>
            </button>
          </div>
          {message && <p className="control-message" role="status">{message}</p>}
        </section>
          </div>
        )}

        {visibleAlerts.length > 0 && (
          <aside className="notification-stack" aria-label="Hardware notifications">
            {visibleAlerts.map((alert) => (
              <div className="popup-notification" key={alert.key} role="alert">
                <TriangleAlert className="popup-notification-icon" size={19} />
                <div className="popup-notification-copy">
                  <strong>{alert.title}</strong>
                  <span>{alert.message}</span>
                </div>
                <button
                  className="notification-dismiss"
                  type="button"
                  title="Dismiss notification"
                  aria-label={`Dismiss ${alert.title} notification`}
                  onClick={() => setDismissedAlerts((current) => new Set(current).add(alert.key))}
                >
                  <X size={17} />
                </button>
              </div>
            ))}
          </aside>
        )}

        <footer className="dashboard-footer">
          <span>ESP32 dual battery monitor</span>
          <span>Rated capacity <strong>{health?.battery1?.ratedCapacityAh ?? 100} Ah</strong></span>
        </footer>
      </main>
    </div>
  )
}

export default App
