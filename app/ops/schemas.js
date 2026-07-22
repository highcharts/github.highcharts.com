'use strict'

const { OpsHttpError } = require('./http')

const OPERATIONS = Object.freeze(['cache.evict_commit', 'cache.purge_expired', 'cache.clear'])
const TARGETS = Object.freeze(['downloader', 'builder'])
const OUTCOMES = Object.freeze(['completed', 'no_op', 'partial', 'failed', 'unknown'])
const SERVICES = Object.freeze(['router', 'downloader', 'builder'])
const SHA = /^[0-9a-f]{40}$/
const CODE = /^[\x21-\x7e]{1,64}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

class SchemaError extends OpsHttpError {
  constructor (fields, code = 'INVALID_REQUEST', message = 'Request body is invalid') {
    super(400, code, message, fields)
    this.name = 'SchemaError'
  }
}

function record (value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value
}

function exactKeys (value, required, optional = []) {
  const allowed = new Set([...required, ...optional])
  const fields = Object.keys(value).filter(key => !allowed.has(key)).concat(required.filter(key => !(key in value)))
  if (fields.length) throw new SchemaError(fields)
}

function text (value, field, maximum = 256) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) invalid(field)
  return value
}

function code (value, field) {
  if (typeof value !== 'string' || !CODE.test(value)) invalid(field)
  return value
}

function enumeration (value, values, field) {
  if (!values.includes(value)) invalid(field)
  return value
}

function integer (value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field)
  return value
}

function timestamp (value, field) {
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) invalid(field)
  return value
}

function commit (value, field) {
  if (typeof value !== 'string' || !SHA.test(value)) invalid(field)
  return value
}

function nullable (value, parser, field) {
  return value === null ? null : parser(value, field)
}

function list (value, field, maximum, parser) {
  if (!Array.isArray(value) || value.length > maximum) invalid(field)
  return value.map((entry, index) => parser(entry, `${field}.${index}`))
}

function invalid (field) {
  throw new SchemaError([field])
}

function validateLoginRequest (value) {
  const invalidLogin = () => { throw new OpsHttpError(401, 'UNAUTHORIZED', 'Authentication failed') }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Object.hasOwn(value, 'token') ||
      typeof value.token !== 'string' || Buffer.byteLength(value.token) > 512 ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token)) invalidLogin()
  const decoded = Buffer.from(value.token, 'base64url')
  if (decoded.length !== 32 || decoded.toString('base64url') !== value.token) invalidLogin()
  return { token: value.token }
}

function validateCacheOperationRequest (value) {
  record(value, 'body')
  exactKeys(value, ['operation', 'targets'], ['commit'])
  const operation = enumeration(value.operation, OPERATIONS, 'operation')
  const targets = list(value.targets, 'targets', 2, (target, field) => enumeration(target, TARGETS, field))
  if (!targets.length || new Set(targets).size !== targets.length) invalid('targets')

  if (operation === 'cache.evict_commit') {
    if (typeof value.commit !== 'string' || !SHA.test(value.commit)) invalid('commit')
  } else if (targets.length !== 1 || 'commit' in value) {
    invalid('targets')
  }
  return operation === 'cache.evict_commit'
    ? { operation, targets, commit: value.commit }
    : { operation, targets }
}

function validateError (value, field) {
  record(value, field)
  if (!('code' in value) || !('message' in value)) invalid(field)
  return { code: code(value.code, `${field}.code`), message: text(value.message, `${field}.message`) }
}

function validateTargetResult (value, field, operation) {
  record(value, field)
  const required = ['service', 'outcome', 'removedEntries', 'freedBytes', 'absent', 'skippedInUse', 'error']
  if (operation !== 'cache.clear') required.push('skippedChanged')
  for (const key of required) if (!(key in value)) invalid(`${field}.${key}`)
  if (operation === 'cache.clear' && 'skippedChanged' in value) invalid(`${field}.skippedChanged`)
  const target = {
    service: enumeration(value.service, TARGETS, `${field}.service`),
    outcome: enumeration(value.outcome, OUTCOMES, `${field}.outcome`),
    removedEntries: integer(value.removedEntries, `${field}.removedEntries`),
    freedBytes: integer(value.freedBytes, `${field}.freedBytes`),
    absent: typeof value.absent === 'boolean' ? value.absent : invalid(`${field}.absent`),
    skippedInUse: integer(value.skippedInUse, `${field}.skippedInUse`),
    error: value.error === null ? null : validateError(value.error, `${field}.error`)
  }
  if (operation !== 'cache.clear') target.skippedChanged = integer(value.skippedChanged, `${field}.skippedChanged`)
  if (target.outcome !== deriveTargetOutcome(target)) invalid(`${field}.outcome`)
  return target
}

function deriveTargetOutcome (target) {
  if (target.outcome === 'unknown') return 'unknown'
  if (target.error !== null) return 'failed'
  const skipped = target.skippedInUse > 0 || (target.skippedChanged || 0) > 0
  if (target.removedEntries > 0 && skipped) return 'partial'
  if (target.removedEntries > 0) return 'completed'
  return 'no_op'
}

function deriveCacheOutcome (targets) {
  if (targets.some(target => target.outcome === 'unknown')) return 'unknown'
  const failed = targets.filter(target => target.outcome === 'failed').length
  if (failed === targets.length) return 'failed'
  if (failed) return 'partial'
  if (targets.some(target => target.outcome === 'partial')) return 'partial'
  if (targets.some(target => target.removedEntries > 0)) return 'completed'
  return 'no_op'
}

function validateCacheOperationResponse (value) {
  record(value, 'response')
  for (const key of ['correlationId', 'operation', 'startedAt', 'completedAt', 'outcome', 'targets']) {
    if (!(key in value)) incompatible(key)
  }
  const operation = enumeration(value.operation, OPERATIONS, 'operation')
  const targets = list(value.targets, 'targets', 2, (target, field) => validateTargetResult(target, field, operation))
  if (!targets.length || new Set(targets.map(target => target.service)).size !== targets.length) incompatible('targets')
  const result = {
    correlationId: code(value.correlationId, 'correlationId'),
    operation,
    startedAt: timestamp(value.startedAt, 'startedAt'),
    completedAt: timestamp(value.completedAt, 'completedAt'),
    outcome: enumeration(value.outcome, OUTCOMES, 'outcome'),
    targets
  }
  if (result.outcome !== deriveCacheOutcome(targets)) incompatible('outcome')
  return result
}

function validateServiceSnapshot (value, expectedService) {
  try {
    return parseServiceSnapshot(value, expectedService)
  } catch (error) {
    if (error instanceof SchemaError && error.code !== 'INCOMPATIBLE_SCHEMA') {
      throw new SchemaError(error.fields, 'INCOMPATIBLE_SCHEMA', 'Internal service response is incompatible')
    }
    throw error
  }
}

function parseServiceSnapshot (value, expectedService) {
  record(value, 'snapshot')
  const required = ['schemaVersion', 'service', 'instanceId', 'startedAt', 'observedAt', 'health', 'capabilities', 'queues', 'cache', 'dependencies', 'telemetry']
  for (const key of required) if (!(key in value)) incompatible(key)
  if (value.schemaVersion !== 1) incompatible('schemaVersion')
  const service = enumeration(value.service, SERVICES, 'service')
  if (expectedService && service !== expectedService) incompatible('service')
  return {
    schemaVersion: 1,
    service,
    instanceId: code(value.instanceId, 'instanceId'),
    startedAt: timestamp(value.startedAt, 'startedAt'),
    observedAt: timestamp(value.observedAt, 'observedAt'),
    health: validateHealth(value.health),
    capabilities: list(value.capabilities, 'capabilities', 16, validateCapability),
    queues: list(value.queues, 'queues', 2, validateQueue),
    cache: value.cache === null ? null : validateCache(value.cache),
    dependencies: list(value.dependencies, 'dependencies', 3, validateDependency),
    telemetry: validateTelemetry(value.telemetry),
    activity: value.activity === undefined ? [] : list(value.activity, 'activity', 300, validateActivity),
    failures: value.failures === undefined ? [] : list(value.failures, 'failures', 100, validateFailure)
  }
}

function validateHealth (value) {
  record(value, 'health')
  if (!('status' in value) || !('reasons' in value)) incompatible('health')
  const health = {
    status: enumeration(value.status, ['healthy', 'degraded', 'unhealthy'], 'health.status'),
    reasons: list(value.reasons, 'health.reasons', 16, (reason, field) => {
      record(reason, field)
      return { code: code(reason.code, `${field}.code`), message: text(reason.message, `${field}.message`) }
    })
  }
  if (health.status !== 'healthy' && !health.reasons.length) incompatible('health.reasons')
  return health
}

function validateCapability (value, field) {
  record(value, field)
  const capability = {
    name: code(value.name, `${field}.name`),
    status: enumeration(value.status, ['available', 'degraded', 'unavailable'], `${field}.status`),
    reasonCode: nullable(value.reasonCode, code, `${field}.reasonCode`)
  }
  if (capability.status !== 'available' && capability.reasonCode === null) incompatible(`${field}.reasonCode`)
  return capability
}

function validateQueue (value, field) {
  record(value, field)
  const queue = {}
  for (const key of ['name', 'active', 'queued', 'limit', 'available', 'oldestQueuedAgeMs']) if (!(key in value)) incompatible(field)
  queue.name = enumeration(value.name, ['download', 'build'], `${field}.name`)
  for (const key of ['active', 'queued', 'limit', 'available']) queue[key] = integer(value[key], `${field}.${key}`)
  queue.oldestQueuedAgeMs = nullable(value.oldestQueuedAgeMs, integer, `${field}.oldestQueuedAgeMs`)
  if (queue.available !== Math.max(0, queue.limit - queue.active - queue.queued)) incompatible(`${field}.available`)
  return queue
}

function validateCache (value) {
  record(value, 'cache')
  const result = {}
  for (const key of ['entryCount', 'totalBytes', 'idleExpiryMs', 'entriesTruncated', 'entries']) if (!(key in value)) incompatible(`cache.${key}`)
  for (const key of ['entryCount', 'totalBytes', 'idleExpiryMs']) result[key] = integer(value[key], `cache.${key}`)
  if (typeof value.entriesTruncated !== 'boolean') incompatible('cache.entriesTruncated')
  result.entriesTruncated = value.entriesTruncated
  result.entries = list(value.entries, 'cache.entries', 200, (entry, field) => {
    record(entry, field)
    if (typeof entry.commit !== 'string' || !SHA.test(entry.commit)) incompatible(`${field}.commit`)
    return {
      commit: entry.commit,
      sizeBytes: integer(entry.sizeBytes, `${field}.sizeBytes`),
      lastAccessedAt: timestamp(entry.lastAccessedAt, `${field}.lastAccessedAt`),
      expiresAt: timestamp(entry.expiresAt, `${field}.expiresAt`),
      inUse: integer(entry.inUse, `${field}.inUse`)
    }
  })
  return result
}

function validateDependency (value, field) {
  record(value, field)
  return {
    name: enumeration(value.name, ['github', 'downloader', 'builder'], `${field}.name`),
    status: enumeration(value.status, ['available', 'degraded', 'unavailable', 'unknown'], `${field}.status`),
    lastAttemptAt: nullable(value.lastAttemptAt, timestamp, `${field}.lastAttemptAt`),
    lastSuccessAt: nullable(value.lastSuccessAt, timestamp, `${field}.lastSuccessAt`),
    lastFailureAt: nullable(value.lastFailureAt, timestamp, `${field}.lastFailureAt`),
    lastLatencyMs: nullable(value.lastLatencyMs, integer, `${field}.lastLatencyMs`),
    errorCode: nullable(value.errorCode, code, `${field}.errorCode`)
  }
}

function validateTelemetry (value) {
  record(value, 'telemetry')
  const result = {}
  for (const key of ['activityDropped', 'completedEvicted', 'failuresEvicted', 'spansDropped']) result[key] = integer(value[key], `telemetry.${key}`)
  return result
}

function validateActivity (value, field) {
  record(value, field)
  const state = enumeration(value.state, ['active', 'completed'], `${field}.state`)
  const activity = {
    correlationId: code(value.correlationId, `${field}.correlationId`),
    state,
    startedAt: timestamp(value.startedAt, `${field}.startedAt`),
    completedAt: nullable(value.completedAt, timestamp, `${field}.completedAt`),
    durationMs: nullable(value.durationMs, integer, `${field}.durationMs`),
    request: validateActivityRequest(value.request, `${field}.request`),
    outcome: validateActivityOutcome(value.outcome, `${field}.outcome`),
    spans: list(value.spans, `${field}.spans`, 8, validateSpan)
  }
  const isComplete = activity.completedAt !== null && activity.durationMs !== null
  if ((state === 'completed') !== isComplete) incompatible(field)
  return activity
}

function validateActivityRequest (value, field) {
  record(value, field)
  return {
    method: code(value.method, `${field}.method`),
    route: text(value.route, `${field}.route`),
    commit: nullable(value.commit, commit, `${field}.commit`),
    resource: nullable(value.resource, controlFreeText, `${field}.resource`),
    buildMode: nullable(value.buildMode, (mode, modeField) => enumeration(mode, ['legacy', 'webpack', 'dashboards', 'esbuild', 'static'], modeField), `${field}.buildMode`)
  }
}

function controlFreeText (value, field) {
  text(value, field)
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid(field)
  return value
}

function validateActivityOutcome (value, field) {
  record(value, field)
  return {
    status: enumeration(value.status, ['succeeded', 'failed', 'rejected', 'aborted'], `${field}.status`),
    httpStatus: nullable(value.httpStatus, httpStatus, `${field}.httpStatus`),
    code: nullable(value.code, code, `${field}.code`)
  }
}

function validateSpan (value, field) {
  record(value, field)
  const state = enumeration(value.state, ['active', 'completed'], `${field}.state`)
  const span = {
    service: enumeration(value.service, SERVICES, `${field}.service`),
    operation: code(value.operation, `${field}.operation`),
    state,
    startedAt: timestamp(value.startedAt, `${field}.startedAt`),
    completedAt: nullable(value.completedAt, timestamp, `${field}.completedAt`),
    durationMs: nullable(value.durationMs, integer, `${field}.durationMs`),
    outcome: validateSpanOutcome(value.outcome, `${field}.outcome`)
  }
  const isComplete = span.completedAt !== null && span.durationMs !== null
  if ((state === 'completed') !== isComplete) incompatible(field)
  return span
}

function validateSpanOutcome (value, field) {
  record(value, field)
  return {
    status: code(value.status, `${field}.status`),
    httpStatus: nullable(value.httpStatus, httpStatus, `${field}.httpStatus`),
    code: nullable(value.code, code, `${field}.code`)
  }
}

function httpStatus (value, field) {
  integer(value, field)
  if (value < 100 || value > 599) invalid(field)
  return value
}

function validateFailure (value, field) {
  record(value, field)
  return {
    occurredAt: timestamp(value.occurredAt, `${field}.occurredAt`),
    correlationId: code(value.correlationId, `${field}.correlationId`),
    service: enumeration(value.service, SERVICES, `${field}.service`),
    operation: code(value.operation, `${field}.operation`),
    code: code(value.code, `${field}.code`),
    summary: text(value.summary, `${field}.summary`),
    httpStatus: nullable(value.httpStatus, httpStatus, `${field}.httpStatus`),
    commit: nullable(value.commit, commit, `${field}.commit`)
  }
}

function incompatible (field) {
  throw new SchemaError([field], 'INCOMPATIBLE_SCHEMA', 'Internal service response is incompatible')
}

module.exports = {
  OPERATIONS,
  OUTCOMES,
  SchemaError,
  TARGETS,
  deriveCacheOutcome,
  validateCacheOperationRequest,
  validateCacheOperationResponse,
  validateLoginRequest,
  validateServiceSnapshot
}
