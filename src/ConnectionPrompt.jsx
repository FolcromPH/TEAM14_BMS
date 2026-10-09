import { useState } from 'react'
import { BatteryCharging, Check, Plus } from 'lucide-react'

// Shown whenever telemetry resumes after a break. Until the user answers, the Worker keeps recording
// readings but freezes SOC / cycle tracking, so a swapped battery cannot corrupt the old one's history.

function formatWhen(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : 'never'
}

function formatGap(seconds) {
  if (!Number.isFinite(seconds)) return 'a while'
  if (seconds < 120) return `${seconds} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} days`
}

function SlotChoice({ slot, session, value, onChange }) {
  const current = session.current?.[slot]
  const saved = session.saved?.[slot] ?? []
  const label = slot === 1 ? 'Battery 1 (system battery, also powers the ESP32)' : 'Battery 2'

  return (
    <fieldset className="prompt-slot">
      <legend><BatteryCharging size={16} />{label}</legend>

      <label className="prompt-option">
        <input type="radio" name={`slot-${slot}`} checked={value.action === 'same'} onChange={() => onChange({ ...value, action: 'same' })} />
        <span>
          <strong>Same battery{current ? `: ${current.name}` : ''}</strong>
          {current && <small>{current.capacityAh} Ah rated · {current.cycles} scored cycle{current.cycles === 1 ? '' : 's'} · last recorded {formatWhen(current.lastRecordedMs)}</small>}
        </span>
      </label>

      <label className="prompt-option">
        <input type="radio" name={`slot-${slot}`} checked={value.action === 'saved'} onChange={() => onChange({ ...value, action: 'saved', identityId: value.identityId || String(saved.find((item) => item.id !== current?.id)?.id ?? saved[0]?.id ?? '') })} disabled={saved.length === 0} />
        <span>
          <strong>A different saved battery</strong>
          <small>Its recorded data and last SOC / SOH are restored for the computation.</small>
        </span>
      </label>
      {value.action === 'saved' && (
        <select className="battery-history-filter prompt-select" value={value.identityId} onChange={(event) => onChange({ ...value, identityId: event.target.value })} aria-label={`Saved battery for slot ${slot}`}>
          {saved.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name} · {item.capacityAh} Ah · {item.cycles} cycles · SOH {Number.isFinite(item.soh) ? `${item.soh.toFixed(1)}%` : '--'} · last {formatWhen(item.lastRecordedMs)}
            </option>
          ))}
        </select>
      )}

      <label className="prompt-option">
        <input type="radio" name={`slot-${slot}`} checked={value.action === 'new'} onChange={() => onChange({ ...value, action: 'new' })} />
        <span>
          <strong>A new battery</strong>
          <small>Starts with a fresh history under the name you give it.</small>
        </span>
      </label>
      {value.action === 'new' && (
        <div className="prompt-new">
          <label>
            <span>Name</span>
            <input type="text" maxLength={60} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} placeholder="e.g. Lead-acid 40Ah #3" />
          </label>
          <label>
            <span>Capacity (Ah)</span>
            <input type="number" min="0.1" step="0.1" value={value.capacityAh} onChange={(event) => onChange({ ...value, capacityAh: event.target.value })} />
          </label>
          <label>
            <span>Voltage (V)</span>
            <input type="number" min="1" step="0.1" value={value.voltageV} onChange={(event) => onChange({ ...value, voltageV: event.target.value })} />
          </label>
        </div>
      )}
    </fieldset>
  )
}

// Mount with key={session.sinceReadingId} so each new break starts from "same battery" again.
export default function ConnectionPrompt({ session, onResolved }) {
  const [choices, setChoices] = useState({
    1: { action: 'same', identityId: '', name: '', capacityAh: '40', voltageV: '12' },
    2: { action: 'same', identityId: '', name: '', capacityAh: '40', voltageV: '12' },
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const slots = {}
      for (const slot of [1, 2]) {
        const choice = choices[slot]
        slots[slot] = choice.action === 'saved'
          ? { action: 'saved', identityId: Number(choice.identityId) }
          : choice.action === 'new'
            ? { action: 'new', name: choice.name, capacityAh: Number(choice.capacityAh), voltageV: Number(choice.voltageV) }
            : { action: 'same' }
      }
      const response = await fetch('/api/session/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save your answer')
      onResolved()
    } catch (requestError) {
      setError(requestError.message || 'Could not save your answer')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="prompt-backdrop" role="presentation">
      <form className="prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-title" onSubmit={submit}>
        <p className="eyebrow">CONNECTION RESUMED</p>
        <h2 id="prompt-title">Are these the same batteries?</h2>
        <p className="prompt-lead">
          {session.reason === 'sensor'
            ? 'A battery sensor that was missing is reporting again.'
            : `The system was offline for ${formatGap(session.gapSeconds)}.`}
          {' '}Tell us whether the connected batteries are the ones you had before. Readings are still being recorded, but SOC and SOH tracking stay paused until you answer.
        </p>
        <SlotChoice slot={1} session={session} value={choices[1]} onChange={(value) => setChoices((current) => ({ ...current, 1: value }))} />
        <SlotChoice slot={2} session={session} value={choices[2]} onChange={(value) => setChoices((current) => ({ ...current, 2: value }))} />
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="prompt-actions">
          <button className="control-button control-charge" type="submit" disabled={busy}>
            {busy ? 'Saving...' : <><Check size={17} /><span>Confirm</span></>}
          </button>
        </div>
        <p className="prompt-footnote"><Plus size={13} /> You can rename batteries or change their Ah any time in the Batteries tab.</p>
      </form>
    </div>
  )
}
