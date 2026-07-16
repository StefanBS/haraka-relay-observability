'use strict'
// Routing + degradation policy for the relay:
//  - every sender may relay; every recipient is accepted (classification is
//    the backend role's job, not this relay's)
//  - MX resolution is overridden to the configured upstream, so the real
//    outbound queue (disk persistence, retries) does the forwarding
//  - back-pressure: when the disk queue is saturated we tempfail at RCPT
//    time, pushing durability back to the sender's MTA instead of accepting
//    mail we might lose.
//  - dead-letter custody: when retries are exhausted we preserve the message
//    rather than let Haraka unlink it. Nothing is ever destroyed.

const fs = require('node:fs')
const path = require('node:path')
const { make } = require('./lib/prom')
const {
  resolveQueueDir,
  resolveDeadLetterDir,
  backlogForBackpressure,
} = require('./lib/queue')
const { isBounceMessage } = require('./lib/mail')

exports.register = function () {
  this.upstream = {
    exchange: process.env.UPSTREAM_HOST || 'localhost',
    port: parseInt(process.env.UPSTREAM_PORT || '25', 10),
  }
  // Where bounce notifications go. In production this is not configured at all:
  // an NDR is addressed to the sender, so it resolves via ordinary MX lookup to
  // the sender's mail provider, a system entirely independent of our upstream.
  // The demo collapses both roles onto one host behind one fault injector, so
  // that independence has to be restored explicitly or the NDR would be routed
  // into the very outage it is reporting.
  this.sender_mx = {
    exchange: process.env.SENDER_MX_HOST || 'localhost',
    port: parseInt(process.env.SENDER_MX_PORT || '25', 10),
  }
  this.max_depth = parseInt(process.env.QUEUE_MAX_DEPTH || '200', 10)
  this.queue_dir = resolveQueueDir(this)
  this.dead_letter_dir = resolveDeadLetterDir()
  this.bp_rejections = make('Counter', {
    name: 'relay_backpressure_rejections_total',
    help: 'RCPTs tempfailed because the outbound queue is saturated',
  })
  this.bounced = make('Counter', {
    name: 'relay_bounced_total',
    help: 'Messages that exhausted retries and were moved to the dead-letter queue',
  })
  this.dl_failures = make('Counter', {
    name: 'relay_dead_letter_failures_total',
    help: 'Dead-letter writes that failed; the only path on which mail is actually lost',
  })
  this.ndr_failures = make('Counter', {
    name: 'relay_ndr_failures_total',
    help: 'Bounce notifications that could not be delivered; the sender was never told',
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
  const depth = backlogForBackpressure(this.queue_dir, (err) => {
    // fail open (never-lose-mail bias: keep accepting), but loudly:
    // an unreadable queue dir means back-pressure is flying blind
    this.logerror(`cannot read queue dir ${this.queue_dir}: ${err.message}`)
  })
  if (depth >= this.max_depth) {
    this.bp_rejections.inc()
    return next(DENYSOFT, 'relay queue is saturated, retry later')
  }
  next()
}

exports.hook_get_mx = function (next, hmail, domain) {
  // A bounce notification must not be routed through the upstream it is
  // reporting on, or it shares fate with the failure and can never be
  // delivered. Everything else is relayed.
  if (isBounceMessage(hmail)) return next(OK, this.sender_mx)
  next(OK, this.upstream)
}

// Retries are exhausted and core is about to permanently fail this message.
// Two things have to happen before it does, and core will do neither for us:
// preserve the mail, and make sure the sender learns it never arrived.
//
// Returning CONT lets core build the NDR and queue it (routed to sender_mx by
// hook_get_mx above, not into the outage). Core then unlinks the original once
// the NDR is queued, so custody has to be taken *first*; the copy below is
// what survives, and it is also the backstop for the NDR itself failing.
exports.hook_bounce = function (next, hmail, err) {
  // This hook also fires for an NDR that could not be delivered. Core is about
  // to hand it to double_bounce() (its null return-path leaves nobody to notify),
  // which unlinks it. Don't dead-letter it: the customer message it reports on
  // was already preserved by its own bounce, and mixing notifications into the
  // dead-letter queue would corrupt the "customer mail stranded" signal that
  // pages. Count it instead: it means the sender still thinks mail was delivered.
  if (isBounceMessage(hmail)) {
    this.ndr_failures.inc()
    this.logcrit(`bounce notification undeliverable, sender was not told: ${err}`)
    return next()
  }
  const dest = path.join(this.dead_letter_dir, hmail.filename)
  fs.copyFile(hmail.path, dest, (copyErr) => {
    if (copyErr) {
      this.dl_failures.inc()
      this.logcrit(
        `DEAD LETTER WRITE FAILED, message is being lost: ${hmail.filename}: ${copyErr.message}`,
      )
    } else {
      this.bounced.inc()
      this.logcrit(
        `message permanently failed after retry exhaustion, preserved at ${dest}, notifying sender: ${err}`,
      )
    }
    next() // CONT: let core generate and send the NDR
  })
}
