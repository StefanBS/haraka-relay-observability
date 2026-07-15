'use strict'
// Routing + degradation policy for the relay:
//  - every sender may relay; every recipient is accepted (classification is
//    the backend role's job, not this relay's)
//  - MX resolution is overridden to the configured upstream, so the real
//    outbound queue (disk persistence, retries) does the forwarding
//  - back-pressure: when the disk queue is saturated we tempfail at RCPT
//    time, pushing durability back to the sender's MTA instead of accepting
//    mail we might lose. Nothing is ever dropped.

const fs = require('node:fs')
const path = require('node:path')

const client = require('prom-client')

exports.register = function () {
  this.upstream = {
    exchange: process.env.UPSTREAM_HOST || 'localhost',
    port: parseInt(process.env.UPSTREAM_PORT || '25', 10),
  }
  this.max_depth = parseInt(process.env.QUEUE_MAX_DEPTH || '200', 10)
  this.queue_dir =
    this.config.get('queue_dir') || path.join(process.env.HARAKA || '.', 'queue')
  // Shares prom-client's default registry with the metrics plugin; the
  // getSingleMetric guard survives Haraka's plugin hot-reload.
  this.bp_rejections =
    client.register.getSingleMetric('relay_backpressure_rejections_total') ||
    new client.Counter({
      name: 'relay_backpressure_rejections_total',
      help: 'RCPTs tempfailed because the outbound queue is saturated',
    })
  this.loginfo(
    `relaying to ${this.upstream.exchange}:${this.upstream.port}, max queue depth ${this.max_depth}`,
  )
}

exports.hook_mail = function (next, connection) {
  // Core accepts RCPT and routes DATA through the outbound queue when
  // the connection is relaying.
  connection.relaying = true
  next()
}

exports.hook_rcpt = function (next, connection) {
  let depth = 0
  try {
    // __tmp__ files are in-flight writes; error.* are permanently-failed
    // messages Haraka has retired -- neither is deliverable backlog.
    depth = fs
      .readdirSync(this.queue_dir)
      .filter((f) => !f.startsWith('__tmp__') && !f.startsWith('error.')).length
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // fail open (never-lose-mail bias: keep accepting), but loudly --
      // an unreadable queue dir means back-pressure is flying blind
      this.logerror(`cannot read queue dir ${this.queue_dir}: ${err.message}`)
    }
    // ENOENT: queue dir not created yet == empty queue
  }
  if (depth >= this.max_depth) {
    this.bp_rejections.inc()
    return next(DENYSOFT, 'relay queue is saturated, retry later')
  }
  next()
}

exports.hook_get_mx = function (next, hmail, domain) {
  next(OK, this.upstream)
}
