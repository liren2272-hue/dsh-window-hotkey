// Loads the real plugin entry point against a stub context, so the code path the
// host runs (apply -> spawn helper -> read helper log) is exercised before the
// bundle is installed. Results go to a file because the sandboxed shell swallows
// stdout.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, inject } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const logFile = join(here, 'smoke-hotkey.log')
const lines = []

const ctx = {
  inject,
  logger: { info: (m) => lines.push(`info: ${m}`), warn: (m) => lines.push(`warn: ${m}`) },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  timer: {
    timeout(fn, ms) {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    },
  },
}

apply(ctx, { hotkey: 'ctrl+alt+q', logFile, registerTimeoutMs: 10_000 })

setTimeout(() => {
  let log = ''
  try {
    log = readFileSync(logFile, 'utf8')
  } catch (error) {
    log = `(no log: ${error.message})`
  }
  writeFileSync(
    join(here, 'smoke-results.txt'),
    [`inject=${JSON.stringify(inject)}`, ...lines, '--- helper log ---', log, ''].join('\n'),
    'utf8',
  )
  process.exit(0)
}, 6_000)
