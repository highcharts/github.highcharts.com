'use strict'

const API = '/_ops/api/v1'
const SERVICES = ['router', 'downloader', 'builder']
const REMOTE_SERVICES = ['downloader', 'builder']
const COMMIT = /^[0-9a-f]{40}$/
const STATUS = new Set(['healthy', 'degraded', 'unhealthy', 'fresh', 'stale', 'unknown', 'available', 'unavailable', 'active', 'completed', 'no_op', 'partial', 'failed', 'succeeded', 'rejected', 'aborted'])
const ERROR_LABELS = {
  INCOMPATIBLE_SCHEMA: 'The service returned an incompatible response.',
  SERVICE_RESPONSE_TOO_LARGE: 'The service response exceeded its safety limit.',
  SERVICE_TIMEOUT: 'The service did not respond before the deadline.',
  SERVICE_UNAVAILABLE: 'The service is unavailable.',
  RATE_LIMITED: 'Too many requests. Wait before trying again.'
}

const ui = Object.fromEntries([
  'app', 'connection-status', 'refresh', 'snapshot-time', 'aggregate-warning',
  'services', 'queues', 'activity', 'failures', 'cache-summary', 'commit',
  'evict-form', 'evict-error', 'operation-result', 'operation-content',
  'dismiss-result', 'cache-entries', 'expiry-warning', 'stay-signed-in',
  'session-status', 'logout'
].map(id => [id, document.querySelector('#' + id)]))

let session
let snapshot
let refreshTimer
let expiryTimer
let expiryRedirectTimer
let refreshing = false
const pendingServices = new Set()

bootstrap()

async function bootstrap () {
  try {
    await renewSession()
    ui.app.hidden = false
    bindEvents()
    await refreshSnapshot()
  } catch (error) {
    if (!error.auth) authLost()
  }
}

function bindEvents () {
  ui.refresh.addEventListener('click', refreshSnapshot)
  ui['evict-form'].addEventListener('submit', evictCommit)
  ui['dismiss-result'].addEventListener('click', () => { ui['operation-result'].hidden = true })
  ui['stay-signed-in'].addEventListener('click', renewSession)
  ui.logout.addEventListener('click', logout)
  document.querySelectorAll('[data-operation]').forEach(button => {
    button.addEventListener('click', () => mutate(button.dataset.operation, [button.dataset.service]))
  })
  document.addEventListener('visibilitychange', resumeRefresh)
  window.addEventListener('online', resumeRefresh)
  window.addEventListener('offline', pauseRefresh)
}

async function request (path, options) {
  const response = await fetch(API + path, { credentials: 'same-origin', ...options })
  if (response.status === 401) {
    authLost()
    throw Object.assign(new Error('Authentication required'), { auth: true })
  }
  if (response.status === 204) return null
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = safeCode(body?.error?.code)
    throw Object.assign(new Error(ERROR_LABELS[code] || 'The request could not be completed.'), { code })
  }
  return body
}

async function renewSession () {
  session = await request('/session')
  renderSession()
}

async function refreshSnapshot () {
  if (refreshing || document.hidden || !navigator.onLine) return
  refreshing = true
  clearTimeout(refreshTimer)
  ui.refresh.disabled = document.activeElement !== ui.refresh
  ui.services.setAttribute('aria-busy', 'true')
  setConnection(snapshot ? 'Refreshing' : 'Loading snapshot')

  try {
    snapshot = await request('/snapshot')
    renderSnapshot(snapshot)
    setConnection('Current')
  } catch (error) {
    if (!error.auth) {
      setConnection(snapshot ? 'Refresh failed; showing prior snapshot' : error.message)
      showAggregateWarning(snapshot ? 'Refresh failed. Existing values may be out of date.' : 'Snapshot unavailable. Try a manual refresh.', true)
    }
  } finally {
    refreshing = false
    ui.refresh.disabled = false
    ui.services.setAttribute('aria-busy', 'false')
    scheduleRefresh(snapshot?.refreshAfterMs)
  }
}

function renderSnapshot (data) {
  const observed = date(data.observedAt)
  ui['snapshot-time'].textContent = observed ? 'Observed ' + observed : 'Observation time unavailable'
  replace(ui.services, SERVICES.map(service => servicePanel(service, data.services?.[service])))
  renderQueues(data.services)
  renderActivity(data.activity)
  renderFailures(data.failures)
  renderCaches(data.services)
  const unavailable = SERVICES.filter(service => data.services?.[service]?.freshness === 'unknown')
  showAggregateWarning(unavailable.length ? 'Partial snapshot. Unavailable: ' + unavailable.map(label).join(', ') + '.' : '', false)
}

function servicePanel (service, slot) {
  const panel = element('article', 'panel')
  const head = element('div', 'record-head')
  head.append(element('h3', '', label(service)))
  const freshness = slot?.freshness === 'unknown' ? 'unavailable' : slot?.freshness
  head.append(status(freshness || 'unknown'))
  panel.append(head)

  if (!slot || slot.freshness === 'unknown' || !slot.snapshot) {
    panel.append(element('p', 'quiet', 'No current service values.'))
    panel.append(facts([
      ['Last attempt', date(slot?.lastAttemptAt) || 'Not yet attempted'],
      ['Reason', errorLabel(slot?.error?.code)]
    ]))
    return panel
  }

  panel.append(status(slot.snapshot.health?.status))
  panel.append(facts([
    ['Freshness', slot.freshness === 'stale' ? 'Stale, ' + duration(slot.ageMs) + ' old' : 'Fresh'],
    ['Observed', date(slot.snapshot.observedAt) || 'Unavailable'],
    ['Started', date(slot.snapshot.startedAt) || 'Unavailable'],
    ['Instance', text(slot.snapshot.instanceId, 64) || 'Unavailable']
  ]))
  if (slot.error) panel.append(element('p', 'quiet', errorLabel(slot.error.code)))

  const reasons = limited(slot.snapshot.health?.reasons, 16)
  if (reasons.length) {
    const list = element('ul')
    reasons.forEach(reason => list.append(element('li', '', text(reason?.message, 256) || safeCode(reason?.code))))
    panel.append(list)
  }
  return panel
}

function renderQueues (services) {
  const queues = SERVICES.flatMap(service => limited(services?.[service]?.snapshot?.queues, 8).map(queue => ({ service, queue })))
  const records = queues.map(({ service, queue }) => {
    const record = element('article', 'record')
    record.append(recordHead(label(service) + ' / ' + text(queue.name, 64), queue.active + queue.queued >= queue.limit && queue.limit > 0 ? 'degraded' : 'available'))
    record.append(facts([
      ['Active', integer(queue.active)], ['Queued', integer(queue.queued)],
      ['Capacity', integer(queue.limit)], ['Available', integer(queue.available)],
      ['Oldest queued', queue.oldestQueuedAgeMs === null ? 'None' : duration(queue.oldestQueuedAgeMs)]
    ]))
    return record
  })
  replace(ui.queues, records.length ? records : [empty('No active or configured queues were reported.')])
}

function renderActivity (activity) {
  const records = limited(activity, 600)
  const children = records.map(trace => {
    const record = element('article', 'record')
    const outcome = trace.state === 'active' ? 'active' : trace.outcome?.status
    record.append(recordHead(text(trace.request?.method, 16) + ' ' + text(trace.request?.route, 256), outcome))
    record.append(facts([
      ['Started', date(trace.startedAt) || 'Unavailable'],
      ['Duration', trace.durationMs === null ? 'In progress' : duration(trace.durationMs)],
      ['Resource', text(trace.request?.resource, 256) || 'None'],
      ['Commit', text(trace.request?.commit, 40) || 'None'],
      ['Build mode', text(trace.request?.buildMode, 16) || 'None'],
      ['Correlation', text(trace.correlationId, 64)]
    ]))
    const spans = limited(trace.spans, 8)
    if (spans.length) {
      const details = element('details')
      details.append(element('summary', '', 'Stages (' + spans.length + ')'))
      spans.forEach(span => details.append(facts([
        ['Service', label(span.service)], ['Operation', humanize(span.operation)],
        ['State', humanize(span.state)], ['Duration', span.durationMs === null ? 'In progress' : duration(span.durationMs)],
        ['Outcome', humanize(span.outcome?.status)], ['Code', safeCode(span.outcome?.code) || 'None']
      ])))
      record.append(details)
    }
    return record
  })
  replace(ui.activity, children.length ? children : [empty('No recent public request activity.')])
}

function renderFailures (failures) {
  const records = limited(failures, 300)
  const children = records.map(failure => {
    const record = element('article', 'record')
    record.append(recordHead(label(failure.service) + ' / ' + humanize(failure.operation), 'failed'))
    record.append(element('p', '', text(failure.summary, 256) || 'Operational failure'))
    record.append(facts([
      ['Occurred', date(failure.occurredAt) || 'Unavailable'],
      ['Code', safeCode(failure.code) || 'INTERNAL_ERROR'],
      ['HTTP status', failure.httpStatus === null ? 'None' : integer(failure.httpStatus)],
      ['Commit', text(failure.commit, 40) || 'None'],
      ['Correlation', text(failure.correlationId, 64)]
    ]))
    return record
  })
  replace(ui.failures, children.length ? children : [empty('No recent failures.')])
}

function renderCaches (services) {
  const summaries = []
  const entries = []
  REMOTE_SERVICES.forEach(service => {
    const slot = services?.[service]
    const cache = slot?.snapshot?.cache
    const panel = element('article', 'panel')
    panel.append(recordHead(label(service), slot?.freshness === 'unknown' ? 'unavailable' : slot?.freshness))
    if (!cache) {
      panel.append(element('p', 'quiet', 'Cache inspection unavailable.'))
    } else {
      panel.append(facts([
        ['Entries', integer(cache.entryCount)], ['Size', bytes(cache.totalBytes)],
        ['Idle expiry', duration(cache.idleExpiryMs)], ['List', cache.entriesTruncated ? 'Most recent 200' : 'Complete']
      ]))
      limited(cache.entries, 200).forEach(entry => entries.push(cacheEntry(service, entry, slot.freshness)))
    }
    summaries.push(panel)
  })
  replace(ui['cache-summary'], summaries)
  replace(ui['cache-entries'], entries.length ? entries : [empty('No cache entries. This is a normal empty state.')])
}

function cacheEntry (service, entry, freshness) {
  const record = element('article', 'record')
  record.append(recordHead(label(service), freshness))
  record.append(element('p', 'mono', text(entry.commit, 40)))
  record.append(facts([
    ['Size', bytes(entry.sizeBytes)], ['In use', integer(entry.inUse)],
    ['Last accessed', date(entry.lastAccessedAt) || 'Unavailable'], ['Expires', date(entry.expiresAt) || 'Unavailable']
  ]))
  const use = element('button', 'button-quiet', 'Prepare eviction')
  use.type = 'button'
  use.addEventListener('click', () => {
    ui.commit.value = text(entry.commit, 40)
    document.querySelectorAll('input[name="target"]').forEach(input => { input.checked = input.value === service })
    ui.commit.focus()
  })
  record.append(use)
  return record
}

async function evictCommit (event) {
  event.preventDefault()
  const commit = ui.commit.value
  const targets = [...document.querySelectorAll('input[name="target"]:checked')].map(input => input.value)
  if (!COMMIT.test(commit) || !targets.length) {
    ui['evict-error'].textContent = 'Enter a full lowercase commit SHA and select at least one target.'
    ui.commit.setAttribute('aria-invalid', 'true')
    return
  }
  ui['evict-error'].textContent = ''
  ui.commit.removeAttribute('aria-invalid')
  await mutate('cache.evict_commit', targets, commit)
}

async function mutate (operation, targets, commit) {
  if (targets.some(service => pendingServices.has(service))) return
  targets.forEach(service => pendingServices.add(service))
  updateMutationControls()
  showPendingResult(operation, targets)

  try {
    const body = { operation, targets }
    if (commit) body.commit = commit
    const result = await request('/cache-operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ops-CSRF': session.csrfToken },
      body: JSON.stringify(body)
    })
    renderOperationResult(result)
    await refreshSnapshot()
  } catch (error) {
    if (!error.auth) renderOperationError(error)
  } finally {
    targets.forEach(service => pendingServices.delete(service))
    updateMutationControls()
  }
}

function showPendingResult (operation, targets) {
  ui['operation-result'].hidden = false
  replace(ui['operation-content'], [
    status('active'),
    element('p', '', humanize(operation) + ' is running for ' + targets.map(label).join(' and ') + '.')
  ])
  ui['operation-result'].focus()
}

function renderOperationResult (result) {
  const children = [status(result.outcome), facts([
    ['Operation', humanize(result.operation)], ['Completed', date(result.completedAt) || 'Unavailable'],
    ['Correlation', text(result.correlationId, 64)]
  ])]
  if (result.outcome === 'unknown') children.push(element('p', 'notice notice-warning', 'The outcome is unknown. Inspect a fresh cache snapshot before deciding whether to retry.'))
  limited(result.targets, 2).forEach(target => {
    const record = element('article', 'record')
    record.append(recordHead(label(target.service), target.outcome))
    record.append(facts([
      ['Removed', integer(target.removedEntries)], ['Freed', bytes(target.freedBytes)],
      ['Absent', target.absent ? 'Yes' : 'No'], ['Skipped in use', integer(target.skippedInUse)],
      ['Skipped changed', target.skippedChanged === undefined ? 'Not applicable' : integer(target.skippedChanged)],
      ['Error', target.error ? errorLabel(target.error.code) : 'None']
    ]))
    children.push(record)
  })
  replace(ui['operation-content'], children)
  ui['operation-result'].focus()
}

function renderOperationError (error) {
  replace(ui['operation-content'], [status('failed'), element('p', '', error.message)])
  ui['operation-result'].hidden = false
  ui['operation-result'].focus()
}

function updateMutationControls () {
  document.querySelectorAll('[data-service]').forEach(button => { button.disabled = pendingServices.has(button.dataset.service) })
  document.querySelectorAll('input[name="target"]').forEach(input => { input.disabled = pendingServices.has(input.value) })
  const selected = [...document.querySelectorAll('input[name="target"]:checked')]
  ui['evict-form'].querySelector('button').disabled = selected.some(input => pendingServices.has(input.value))
}

function renderSession () {
  clearTimeout(expiryTimer)
  clearTimeout(expiryRedirectTimer)
  const idle = Date.parse(session.idleExpiresAt)
  const absolute = Date.parse(session.absoluteExpiresAt)
  const expiry = Math.min(idle, absolute)
  ui['session-status'].textContent = 'Idle expiry ' + date(session.idleExpiresAt) + '. Absolute expiry ' + date(session.absoluteExpiresAt) + '.'
  const updateWarning = () => {
    ui['expiry-warning'].hidden = expiry - Date.now() > 5 * 60 * 1000
  }
  updateWarning()
  expiryTimer = setTimeout(updateWarning, Math.max(0, expiry - Date.now() - 5 * 60 * 1000))
  expiryRedirectTimer = setTimeout(authLost, Math.max(0, expiry - Date.now()))
}

async function logout () {
  ui.logout.disabled = true
  try {
    await request('/session', { method: 'DELETE', headers: { 'X-Ops-CSRF': session.csrfToken } })
  } finally {
    authLost()
  }
}

function authLost () {
  clearTimeout(refreshTimer)
  clearTimeout(expiryTimer)
  clearTimeout(expiryRedirectTimer)
  window.location.replace('/_ops/login')
}

function pauseRefresh () {
  clearTimeout(refreshTimer)
  setConnection(navigator.onLine ? 'Refresh paused while hidden' : 'Offline; showing last snapshot')
}

function resumeRefresh () {
  if (!document.hidden && navigator.onLine) refreshSnapshot()
  else pauseRefresh()
}

function scheduleRefresh (milliseconds) {
  clearTimeout(refreshTimer)
  if (document.hidden || !navigator.onLine) return pauseRefresh()
  const delay = Number.isSafeInteger(milliseconds) && milliseconds >= 5000 ? milliseconds : 30000
  const next = new Date(Date.now() + delay)
  setConnection('Current; next refresh ' + next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
  refreshTimer = setTimeout(refreshSnapshot, delay)
}

function showAggregateWarning (message, error) {
  ui['aggregate-warning'].hidden = !message
  ui['aggregate-warning'].className = 'notice' + (error ? ' notice-error' : ' notice-warning')
  ui['aggregate-warning'].textContent = message
}

function setConnection (message) {
  ui['connection-status'].textContent = message
}

function recordHead (title, state) {
  const head = element('div', 'record-head')
  head.append(element('h3', '', title || 'Unknown'), status(state))
  return head
}

function status (value) {
  const safe = STATUS.has(value) ? value : 'unknown'
  const shown = safe === 'no_op' ? 'No action needed' : safe === 'unknown' ? 'Unavailable' : humanize(safe)
  return element('span', 'status status-' + safe, shown)
}

function facts (items) {
  const list = element('dl', 'facts')
  items.forEach(([name, value]) => {
    const group = element('div')
    group.append(element('dt', '', name), element('dd', '', String(value ?? 'Unavailable')))
    list.append(group)
  })
  return list
}

function empty (message) {
  return element('p', 'record quiet', message)
}

function replace (parent, children) {
  parent.replaceChildren(...children)
}

function element (tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function limited (value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : []
}

function text (value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function safeCode (value) {
  const code = text(value, 64)
  return /^[A-Za-z0-9_.-]+$/.test(code) ? code : ''
}

function errorLabel (code) {
  const safe = safeCode(code)
  return ERROR_LABELS[safe] || (safe ? 'Service error: ' + safe : 'Reason unavailable.')
}

function label (value) {
  const labels = { router: 'Router', downloader: 'Downloader', builder: 'Builder' }
  return labels[value] || 'Unknown service'
}

function humanize (value) {
  const safe = text(value, 64).replace(/[^A-Za-z0-9_.-]/g, '')
  return safe ? safe.replace(/[._-]+/g, ' ').replace(/^./, letter => letter.toUpperCase()) : 'Unknown'
}

function integer (value) {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Unavailable'
}

function duration (value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'Unavailable'
  if (value < 1000) return value + ' ms'
  if (value < 60000) return (value / 1000).toFixed(1) + ' s'
  if (value < 3600000) return Math.round(value / 60000) + ' min'
  return (value / 3600000).toFixed(1) + ' h'
}

function bytes (value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'Unavailable'
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB'
  return (value / (1024 * 1024)).toFixed(1) + ' MiB'
}

function date (value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : ''
}
