// Emits the exact PowerShell program the plugin would spawn, so the helper can
// be exercised outside the host process.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildHelperScript, parseHotkey } from '../hotkey.js'

const here = dirname(fileURLToPath(import.meta.url))
const logFile = process.env.DSH_HOTKEY_TEST_LOG ?? join(process.env.TEMP ?? '.', 'dsh-hotkey', 'test-helper.log')
const hotkey = process.env.DSH_HOTKEY_TEST_COMBO ?? 'ctrl+alt+q'
const parentPid = Number(process.env.DSH_HOTKEY_TEST_PARENT ?? '0') || 0

const combo = parseHotkey(hotkey)
const registerTimeoutMs = Number(process.env.DSH_HOTKEY_TEST_REGISTER_TIMEOUT ?? '8000')
const script = buildHelperScript({ windowTitle: process.env.DSH_HOTKEY_TEST_TITLE ?? 'DeepSeek Harness', logFile }, combo, {
  parentPid,
  registerTimeoutMs,
})

const out = join(here, process.env.DSH_HOTKEY_TEST_OUT ?? 'generated-helper.ps1')
writeFileSync(out, script, 'utf8')
writeFileSync(join(here, 'gen-status.txt'), `combo=${combo.label} mods=${combo.mods} vk=${combo.vk} bytes=${script.length} out=${out} parent=${parentPid} timeout=${registerTimeoutMs}\n`, 'utf8')
