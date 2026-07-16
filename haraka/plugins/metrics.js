'use strict'
// The four 3am signals, one plugin:
//   flow balance   relay_received_total / relay_delivered_total
//   failures & why relay_deferred_total{reason}
//   latency        relay_delivery_duration_seconds (accept -> upstream handoff)
//   queue state    relay_queue_depth / relay_queue_oldest_age_seconds
//                  relay_dead_letter_depth
// Served on Haraka's built-in HTTP server (config/http.ini).
//
// Permanent-failure counters (relay_bounced_total, relay_dead_letter_failures_total)
// live in route_upstream.js instead: that hook has to take custody of the message
// before core unlinks it, and the counter belongs with the decision it records.

const { client, make } = require('./lib/prom')
const {
  resolveQueueDir,
  resolveDeadLetterDir,
  scanForMetrics,
  countDeadLetters,
} = require('./lib/queue')
const { isBounceMessage } = require('./lib/mail')

// Bounded cardinality: these six reasons, never raw error strings.
const DEFER_REASONS = ['unreachable', 'refused', 'timeout', '4xx', '5xx', 'other']

let plugin = null // set in register(); lets module-scope code log via Haraka

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
  const queue_dir = resolveQueueDir(this)

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
  for (const r of DEFER_REASONS) {
    this.deferred.labels(r).inc(0)
  }
  this.ndr_sent = make('Counter', {
    name: 'relay_ndr_sent_total',
    help: 'Bounce notifications delivered to senders; proof the sender was told',
  })
  this.duration = make('Histogram', {
    name: 'relay_delivery_duration_seconds',
    help: 'Accept-to-upstream-handoff latency, including queue wait',
    buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300],
  })
  const onQueueReadError = (err) => {
    // Never throw: one EACCES must not 500 /metrics mid-incident.
    if (plugin) plugin.logerror(`cannot read queue dir ${queue_dir}: ${err.message}`)
    else console.error(`[metrics] cannot read queue dir ${queue_dir}: ${err.message}`)
  }
  make('Gauge', {
    name: 'relay_queue_depth',
    help: 'Messages sitting in the outbound queue',
    collect() {
      this.set(scanForMetrics(queue_dir, onQueueReadError).depth)
    },
  })
  make('Gauge', {
    name: 'relay_queue_oldest_age_seconds',
    help: 'Age of the oldest message in the outbound queue',
    collect() {
      this.set(scanForMetrics(queue_dir, onQueueReadError).oldest_age)
    },
  })
  const dead_letter_dir = resolveDeadLetterDir()
  const onDeadLetterReadError = (err) => {
    if (plugin) plugin.logerror(`cannot read dead-letter dir: ${err.message}`)
  }
  // A gauge, not a counter: these messages sit until a human drains them, so
  // the useful question is "how much mail is stranded right now", and it only
  // returns to zero when someone actually deals with it.
  make('Gauge', {
    name: 'relay_dead_letter_depth',
    help: 'Messages preserved after exhausting retries, awaiting manual replay',
    collect() {
      this.set(countDeadLetters(dead_letter_dir, onDeadLetterReadError))
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

// Bounce notifications travel through the same outbound queue as customer mail,
// so every hook below sees them too. They are the relay's own traffic, not
// accepted customer messages, and counting them here would inflate the flow
// balance (delivered would exceed received, since an NDR never hits
// hook_queue_ok) and pollute the SLI histogram with latency no customer waits
// on. They get their own counters instead.
exports.hook_delivered = function (next, hmail) {
  if (isBounceMessage(hmail)) {
    this.ndr_sent.inc()
    return next()
  }
  this.delivered.inc()
  if (hmail && hmail.todo && hmail.todo.queue_time) {
    this.duration.observe((Date.now() - hmail.todo.queue_time) / 1000)
  }
  next()
}

exports.hook_deferred = function (next, hmail, params) {
  // A deferring NDR is reported by relay_ndr_failures_total if it ultimately
  // fails; keeping it out of the reason buckets keeps those about customer mail.
  if (!isBounceMessage(hmail)) {
    this.deferred.labels(bucket_reason(params && params.err)).inc()
  }
  next() // CONT; anything else deletes the queued message
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
