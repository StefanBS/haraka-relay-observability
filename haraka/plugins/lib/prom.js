'use strict'
// Survives Haraka's plugin hot-reload without double-registering.

const client = require('prom-client')

function make(kind, opts) {
  return client.register.getSingleMetric(opts.name) || new client[kind](opts)
}

module.exports = { client, make }
