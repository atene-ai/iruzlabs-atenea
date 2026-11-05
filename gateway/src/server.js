#!/usr/bin/env node
// Starts the gateway with the settings in the environment (see README.md).
import { ConfigError, loadConfig } from './config.js'
import { createGateway } from './gateway.js'

let config
try {
  config = loadConfig()
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(`gateway: ${error.message}`)
  process.exit(2)
}

const gateway = createGateway(config)
const address = await gateway.listen()
console.log(`gateway: listening on ${address.address}:${address.port}, forwarding to ${config.dsh.upstream}`)

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    setTimeout(() => process.exit(0), 5_000).unref()
    gateway.close().then(() => process.exit(0))
  })
}
