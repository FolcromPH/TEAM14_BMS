import { useEffect, useState } from 'react'
import { BatteryCharging, CheckCircle2, ClipboardPlus, Download, Plus, Repeat2, Save, Trash2, X } from 'lucide-react'
import './App.css'

const SLOTS = [1, 2]

function blankBattery(slot) {
  return {
    slot,
    name: `Battery ${slot}`,
    voltageV: '12',
    capacityValue: '40',
    capacityUnit: 'Ah',
  }
}

function toForm(battery) {
  return {
    slot: battery.slot,
    name: battery.name,
    voltageV: String(battery.voltage_v),
    capacityValue: String(battery.capacity_mah / 1000),
    capacityUnit: 'Ah',
  }
}

function formatWhen(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : 'no data yet'
}

export default function BatteryInventory() {
  const [batteries, setBatteries] = useState({})
  const [saved, setSaved] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingSlot, setSavingSlot] = useState(null)
  const [creatingReading, setCreatingReading] = useState(false)
  const [notification, setNotification] = useState(null)
  const [message, setMessage] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [confirmText, setConfirmText] = useState('')

  async function loadBatteries() {
    const response = await fetch('/api/batteries')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not load battery records')
    setBatteries(Object.fromEntries(result.batteries.map((battery) => [battery.slot, toForm(battery)])))
    setSaved(result.saved ?? [])
  }

  useEffect(() => {
    let stopped = false

    async function load() {
      try {
        const response = await fetch('/api/batteries')
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load battery records')
        if (!stopped) {
          setBatteries(Object.fromEntries(result.batteries.map((battery) => [battery.slot, toForm(battery)])))
          setSaved(result.saved ?? [])
        }
      } catch (error) {
        if (!stopped) setMessage(error.message || 'Could not load battery records')
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    load()
    return () => { stopped = true }
  }, [])

  function updateBattery(slot, field, value) {
    setBatteries((current) => ({
      ...current,
      [slot]: { ...(current[slot] ?? blankBattery(slot)), [field]: value },
    }))
  }

  function changeCapacityUnit(slot, unit) {
    setBatteries((current) => {
      const battery = current[slot] ?? blankBattery(slot)
      const capacityMah = Number(battery.capacityValue) * (battery.capacityUnit === 'Ah' ? 1000 : 1)
      return {
        ...current,
        [slot]: {
          ...battery,
          capacityUnit: unit,
          capacityValue: String(unit === 'Ah' ? capacityMah / 1000 : capacityMah),
        },
      }
    })
  }

  async function saveBattery(slot) {
    setSavingSlot(slot)
    setMessage('')
    const battery = batteries[slot] ?? blankBattery(slot)
    try {
      const response = await fetch('/api/batteries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot,
          name: battery.name,
          voltageV: Number(battery.voltageV),
          capacityMah: Number(battery.capacityValue) * (battery.capacityUnit === 'Ah' ? 1000 : 1),
        }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not save battery')
      await loadBatteries()
      setMessage(result.createdIdentity
        ? `${result.battery.name} saved as a new battery. Its history starts empty; earlier readings stay with the previous battery.`
        : result.switchedToSaved
          ? `${result.battery.name} was already saved for slot ${slot}, so its recorded history and last SOC / SOH are back in use.`
          : result.capacityChanged
            ? `${result.battery.name} now uses ${Number(battery.capacityValue) * (battery.capacityUnit === 'Ah' ? 1 : 0.001)} Ah from the next reading on. SOC already recorded was not recalculated, and cycles recorded earlier keep the capacity they were measured against.`
            : `${result.battery.name} saved`)
    } catch (error) {
      setMessage(error.message || 'Could not save battery')
    } finally {
      setSavingSlot(null)
    }
  }

  async function activateSaved(slot, identityId) {
    setSavingSlot(slot)
    setMessage('')
    try {
      const response = await fetch('/api/batteries/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, identityId }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not switch battery')
      await loadBatteries()
      setMessage(`${result.battery.name} is now the battery in slot ${slot}. Its recorded data and last SOC / SOH are used from the next reading.`)
    } catch (error) {
      setMessage(error.message || 'Could not switch battery')
    } finally {
      setSavingSlot(null)
    }
  }

  async function createReading() {
    setCreatingReading(true)
    setMessage('')
    try {
      const response = await fetch('/api/reading-captures', { method: 'POST' })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not request a new reading')
      setNotification({
        title: 'Reading request successful',
        body: 'Waiting for the system to turn on. The next fresh reading will be saved to battery history.',
      })
    } catch (error) {
      setMessage(error.message || 'Could not request a new reading')
    } finally {
      setCreatingReading(false)
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || confirmText !== pendingDelete.name) return
    const { slot, name } = pendingDelete
    setSavingSlot(slot)
    setMessage('')
    try {
      const response = await fetch(`/api/batteries/${slot}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: confirmText }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not delete battery')
      setBatteries((current) => {
        const next = { ...current }
        delete next[slot]
        return next
      })
      setPendingDelete(null)
      setConfirmText('')
      setMessage(`${name} removed from the active slot. Its saved history remains available.`)
    } catch (error) {
      setMessage(error.message || 'Could not delete battery')
    } finally {
      setSavingSlot(null)
    }
  }

  return (
    <section className="battery-inventory" aria-labelledby="battery-inventory-title">
      <div className="section-heading inventory-heading">
        <div>
          <p className="eyebrow">BATTERY DATABASE</p>
          <h2 id="battery-inventory-title">Battery specifications</h2>
        </div>
        <button
          className="inventory-add-button"
          type="button"
          onClick={createReading}
          disabled={creatingReading}
        >
          <ClipboardPlus size={16} />{creatingReading ? 'Creating...' : 'New reading'}
        </button>
      </div>

      <div className="inventory-grid">
        {SLOTS.map((slot) => {
          const battery = batteries[slot] ?? blankBattery(slot)
          const exists = Boolean(batteries[slot])
          return (
            <form
              className="inventory-battery"
              id={`battery-slot-${slot}`}
              key={slot}
              onSubmit={(event) => {
                event.preventDefault()
                saveBattery(slot)
              }}
            >
              <div className="inventory-card-heading">
                <span className={`battery-symbol battery-symbol-${slot}`}><BatteryCharging size={20} /></span>
                <div>
                  <p className="eyebrow">INA260 SLOT {slot}</p>
                  <h3>{battery.name || `Battery ${slot}`}</h3>
                </div>
                <span className="status-pill">{exists ? 'SAVED' : 'NOT ADDED'}</span>
              </div>

              <label className="inventory-field">
                <span>Battery name</span>
                <input
                  required
                  maxLength={60}
                  value={battery.name}
                  onChange={(event) => updateBattery(slot, 'name', event.target.value)}
                  placeholder={`Battery ${slot}`}
                />
              </label>
              <div className="inventory-number-fields">
                <label className="inventory-field">
                  <span>Nominal voltage</span>
                  <div className="number-input-wrap">
                    <input
                      required
                      min="0.1"
                      max="1000"
                      step="0.1"
                      type="number"
                      value={battery.voltageV}
                      onChange={(event) => updateBattery(slot, 'voltageV', event.target.value)}
                    />
                    <span>V</span>
                  </div>
                </label>
                <label className="inventory-field">
                  <span>Rated capacity</span>
                  <div className="number-input-wrap capacity-input-wrap">
                    <input
                      required
                      min={battery.capacityUnit === 'Ah' ? '0.001' : '1'}
                      max={battery.capacityUnit === 'Ah' ? '1000' : '1000000'}
                      step={battery.capacityUnit === 'Ah' ? '0.01' : '1'}
                      type="number"
                      value={battery.capacityValue}
                      onChange={(event) => updateBattery(slot, 'capacityValue', event.target.value)}
                      placeholder={battery.capacityUnit === 'Ah' ? 'e.g. 10' : 'e.g. 10000'}
                    />
                    <select
                      className="inventory-unit-select"
                      aria-label={`Battery ${slot} capacity unit`}
                      value={battery.capacityUnit}
                      onChange={(event) => changeCapacityUnit(slot, event.target.value)}
                    >
                      <option value="Ah">Ah</option>
                      <option value="mAh">mAh</option>
                    </select>
                  </div>
                </label>
              </div>

              <p className="inventory-hint">
                Changing the Ah applies to SOC, SOH, cycles-to-80% and every screen from the next reading on.
              </p>

              <div className="inventory-actions">
                <button className="control-button control-charge" type="submit" disabled={loading || savingSlot !== null}>
                  {exists ? <Save size={16} /> : <Plus size={16} />}
                  <span>{savingSlot === slot ? 'Saving...' : exists ? 'Save changes' : 'Add battery'}</span>
                </button>
                {exists && (
                  <button
                    className="inventory-delete"
                    type="button"
                    disabled={savingSlot !== null}
                    onClick={() => {
                      setPendingDelete({ slot, name: battery.name })
                      setConfirmText('')
                    }}
                    aria-label={`Delete Battery ${slot} specifications`}
                    title="Remove battery specifications"
                  >
                    <Trash2 size={17} />Remove
                  </button>
                )}
              </div>

              <div className="saved-batteries">
                <h4>Saved batteries for slot {slot}</h4>
                {saved.filter((item) => item.slot === slot).length === 0 && <p className="inventory-hint">None yet.</p>}
                <ul>
                  {saved.filter((item) => item.slot === slot).map((item) => (
                    <li key={item.id} className={item.active ? 'saved-active' : ''}>
                      <div>
                        <strong>{item.name}</strong>{item.active && <span className="status-pill status-online">IN USE</span>}
                        <small>
                          {item.capacityAh} Ah · {item.cycles} scored cycle{item.cycles === 1 ? '' : 's'}
                          {' · '}SOH {Number.isFinite(item.soh) ? `${item.soh.toFixed(1)}%` : '--'}
                          {' · '}last recorded {formatWhen(item.lastRecordedMs)}
                        </small>
                      </div>
                      <div className="saved-actions">
                        {!item.active && (
                          <button type="button" className="inventory-cancel" disabled={savingSlot !== null} onClick={() => activateSaved(slot, item.id)}>
                            <Repeat2 size={14} />Use
                          </button>
                        )}
                        <a className="inventory-cancel" href={`/api/cycles.csv?batteryId=${item.id}`} download title="Download this battery's cycle history (CSV)">
                          <Download size={14} />Cycles
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </form>
          )
        })}
      </div>
      {message && <p className="inventory-message" role="status">{message}</p>}
      <p className="analytics-method-note">Each battery is saved by name for its sensor slot, with its own readings, cycles and SOH. Saving a new name starts a new battery; saving a name that is already saved brings that battery's history back. Changing only the Ah updates the same battery in place. Capacity can be entered in Ah or mAh.</p>

      {notification && (
        <div className="inventory-notification" role="status">
          <CheckCircle2 size={19} />
          <div>
            <strong>{notification.title}</strong>
            <span>{notification.body}</span>
          </div>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotification(null)}>
            <X size={17} />
          </button>
        </div>
      )}

      {pendingDelete && (
        <div className="confirmation-backdrop">
          <section
            className="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-battery-title"
            aria-describedby="delete-battery-description"
          >
            <p className="eyebrow">PERMANENT DATABASE CHANGE</p>
            <h3 id="delete-battery-title">You are about to delete {pendingDelete.name}</h3>
            <p id="delete-battery-description">
              This removes {pendingDelete.name} from the active sensor slot. Its saved D1 readings remain available under its battery identity.
            </p>
            <label className="inventory-field confirmation-field">
              <span>Type <strong>{pendingDelete.name}</strong> to confirm</span>
              <input autoComplete="off" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
            </label>
            <div className="confirmation-actions">
              <button className="inventory-cancel" type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button
                className="inventory-confirm-delete"
                type="button"
                disabled={confirmText !== pendingDelete.name || savingSlot !== null}
                onClick={confirmDelete}
              >
                {savingSlot === pendingDelete.slot ? 'Removing...' : 'Remove from active slot'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
