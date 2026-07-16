'use strict'
// Shared outbound-queue helpers. One TTL-cached directory listing feeds both
// the metrics gauges (qfile-shaped depth + oldest age) and back-pressure
// (non-noise file count). Error policy differs by caller on purpose:
//   metrics        - keep serving the previous reading (never 500 /metrics)
//   back-pressure  - fail open with depth 0 (never-lose-mail bias)

const fs = require('node:fs')
const path = require('node:path')

const QUEUE_SCAN_TTL_MS = 2000
// qfile name: $arrival_$nextattempt_$attempts_$pid_$uniq_$counter_$host
const QFILE_RE = /^(\d{13})_\d+_\d+_/

let last = { at: 0, dir: null, depth: 0, oldest_age: 0, backlog: 0 }

function resolveQueueDir(plugin) {
  return (
    plugin.config.get('queue_dir') ||
    path.join(process.env.HARAKA || '.', 'queue')
  )
}

function resolveDeadLetterDir() {
  return process.env.DEAD_LETTER_DIR || '/data/dead-letter'
}

function isNoise(name) {
  // __tmp__ = in-flight write; error. = retired permanently-failed copy
  return name.startsWith('__tmp__') || name.startsWith('error.')
}

function compute(files, now) {
  let depth = 0
  let oldest = null
  let backlog = 0
  for (const f of files) {
    if (isNoise(f)) continue
    backlog++
    const m = f.match(QFILE_RE)
    if (!m) continue
    depth++
    const arrival = parseInt(m[1], 10)
    if (oldest === null || arrival < oldest) oldest = arrival
  }
  return {
    depth,
    oldest_age: oldest === null ? 0 : (now - oldest) / 1000,
    backlog,
  }
}

function refresh(dir, onError) {
  const now = Date.now()
  if (last.dir === dir && now - last.at < QUEUE_SCAN_TTL_MS) {
    return { ok: true, cached: true }
  }
  let files
  try {
    files = fs.readdirSync(dir)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      if (onError) onError(err)
      return { ok: false }
    }
    files = []
  }
  const snap = compute(files, now)
  last = { at: now, dir, ...snap }
  return { ok: true, cached: false }
}

function scanForMetrics(dir, onError) {
  const result = refresh(dir, onError)
  if (!result.ok) {
    // Permission/IO error: keep prior reading (possibly zeros before first success).
    return { depth: last.depth, oldest_age: last.oldest_age }
  }
  return { depth: last.depth, oldest_age: last.oldest_age }
}

function backlogForBackpressure(dir, onError) {
  const result = refresh(dir, onError)
  if (!result.ok) return 0 // fail open
  return last.backlog
}

// Deliberately not routed through refresh(): that cache is keyed on a single
// dir, so alternating queue/dead-letter scans on one scrape would evict each
// other every call. The dead-letter dir is empty in the healthy case anyway.
let last_dl = { at: 0, depth: 0 }

function countDeadLetters(dir, onError) {
  const now = Date.now()
  if (now - last_dl.at < QUEUE_SCAN_TTL_MS) return last_dl.depth
  let files
  try {
    files = fs.readdirSync(dir)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      if (onError) onError(err)
      return last_dl.depth // keep prior reading; never 500 /metrics
    }
    files = []
  }
  last_dl = { at: now, depth: files.filter((f) => !isNoise(f)).length }
  return last_dl.depth
}

module.exports = {
  resolveQueueDir,
  resolveDeadLetterDir,
  scanForMetrics,
  backlogForBackpressure,
  countDeadLetters,
  QUEUE_SCAN_TTL_MS,
}
