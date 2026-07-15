'use strict'
// The four 3am signals, one plugin:
//   flow balance   relay_received_total / relay_delivered_total
//   failures & why relay_deferred_total{reason} / relay_bounced_total
//   latency        relay_delivery_duration_seconds (accept -> upstream handoff)
//   queue state    relay_queue_depth / relay_queue_oldest_age_seconds
// Served on Haraka's built-in HTTP server (config/http.ini).

const fs = require('node:fs')
const path = require('node:path')

const client = require('prom-client')

// Survives Haraka's plugin hot-reload without double-registering.
function make(kind, opts) {
  return client.register.getSingleMetric(opts.name) || new client[kind](opts)
}

// One directory scan feeds both gauges; TTL keeps scrape cost trivial.
const QUEUE_SCAN_TTL_MS = 2000
let last_scan = { at: 0, depth: 0, oldest_age: 0 }
let plugin = null // set in register(); lets module-scope code log via Haraka

function scan_queue(dir) {
  const now = Date.now()
  if (now - last_scan.at < QUEUE_SCAN_TTL_MS) return last_scan
  let depth = 0
  let oldest = null
  let files = []
  try {
    files = fs.readdirSync(dir)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Never throw: one EACCES must not 500 /metrics mid-incident.
      // Log loudly and keep serving the previous (stale) reading.
      if (plugin) plugin.logerror(`cannot read queue dir ${dir}: ${err.message}`)
      else console.error(`[metrics] cannot read queue dir ${dir}: ${err.message}`)
      return last_scan
    }
    // ENOENT == no queue dir yet == empty
  }
  for (const f of files) {
    // __tmp__.  = in-flight write; error.  = retired permanently-failed copy;
    // neither is deliverable backlog
    if (f.startsWith('__tmp__') || f.startsWith('error.')) continue
    // qfile name: $arrival_$nextattempt_$attempts_$pid_$uniq_$counter_$host
    // where $arrival is epoch-ms (13 digits). Anything not matching the real
    // qfile shape is skipped entirely: not counted, not considered for oldest.
    const m = f.match(/^(\d{13})_\d+_\d+_/)
    if (!m) continue
    depth++
    const arrival = parseInt(m[1], 10)
    if (oldest === null || arrival < oldest) {
      oldest = arrival
    }
  }
  last_scan = {
    at: now,
    depth,
    oldest_age: oldest === null ? 0 : (now - oldest) / 1000,
  }
  return last_scan
}

// Bounded cardinality: six reasons, never raw error strings.
function bucket_reason(err) {
  const s = String((err && err.message) || err || '').toLowerCase()
  // When every MX fails to connect, Haraka swallows the socket error and the
  // deferred hook only sees 'Tried all MXs'; connect-refused and
  // connect-timeout are indistinguishable here, so 'unreachable' is the
  // honest bucket. The regexes below still catch SMTP-level errors that do
  // carry those strings.
  if (/tried all mxs/.test(s)) return 'unreachable'
  if (/econnrefused|refused/.test(s)) return 'refused'
  if (/etimedout|timed? ?out/.test(s)) return 'timeout'
  const code = s.match(/\b([45])\d\d\b/)
  if (code) return `${code[1]}xx`
  return 'other'
}

exports.register = function () {
  plugin = this
  const queue_dir =
    this.config.get('queue_dir') || path.join(process.env.HARAKA || '.', 'queue')

  // Same hot-reload guard as make(): default metrics register themselves.
  if (!client.register.getSingleMetric('process_cpu_user_seconds_total')) {
    client.collectDefaultMetrics()
  }

  this.received = make('Counter', {
    name: 'relay_received_total',
    help: 'Messages accepted and durably queued',
  })
  this.delivered = make('Counter', {
    name: 'relay_delivered_total',
    help: 'Messages successfully handed to the upstream',
  })
  this.deferred = make('Counter', {
    name: 'relay_deferred_total',
    help: 'Delivery attempts that temp-failed and were requeued',
    labelNames: ['reason'],
  })
  // Zero-initialize every reason so the series exist from boot;
  // otherwise rate() misses the birth increment.
  for (const r of ['unreachable', 'refused', 'timeout', '4xx', '5xx', 'other']) {
    this.deferred.labels(r).inc(0)
  }
  this.bounced = make('Counter', {
    name: 'relay_bounced_total',
    help: 'Messages permanently failed; mail loss, must stay 0',
  })
  this.duration = make('Histogram', {
    name: 'relay_delivery_duration_seconds',
    help: 'Accept-to-upstream-handoff latency, including queue wait',
    buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300],
  })
  make('Gauge', {
    name: 'relay_queue_depth',
    help: 'Messages sitting in the outbound queue',
    collect() {
      this.set(scan_queue(queue_dir).depth)
    },
  })
  make('Gauge', {
    name: 'relay_queue_oldest_age_seconds',
    help: 'Age of the oldest message in the outbound queue',
    collect() {
      this.set(scan_queue(queue_dir).oldest_age)
    },
  })
}

exports.hook_queue_ok = function (next) {
  // Counts once per transaction; delivered counts once per recipient-domain
  // hmail, so flow balance can skew on multi-domain messages (irrelevant for
  // the single-sink demo).
  this.received.inc()
  next()
}

exports.hook_delivered = function (next, hmail) {
  this.delivered.inc()
  if (hmail && hmail.todo && hmail.todo.queue_time) {
    this.duration.observe((Date.now() - hmail.todo.queue_time) / 1000)
  }
  next()
}

exports.hook_deferred = function (next, hmail, params) {
  this.deferred.labels(bucket_reason(params && params.err)).inc()
  next() // CONT; anything else deletes the queued message
}

exports.hook_bounce = function (next, hmail, err) {
  this.bounced.inc()
  this.logcrit(`message permanently failed: ${err}`)
  next(OK) // suppress sending a bounce message; no real senders exist locally
}

exports.hook_init_http = function (next, Server) {
  // Must register synchronously before next(): core appends its static/404
  // handlers immediately after this hook chain runs.
  Server.http.app.get('/metrics', (req, res) => {
    client.register
      .metrics()
      .then((body) => {
        res.set('Content-Type', client.register.contentType)
        res.send(body)
      })
      .catch((err) => res.status(500).send(String(err)))
  })
  next()
}
