'use strict';

const { startStdio } = require('./worker.cjs');

// Cindy require()s the plugin entry from a host bootstrap process instead of running this
// file directly, so the production entry must start the stdio JSON-RPC loop unconditionally.
startStdio();
