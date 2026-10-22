// Hotkey string parsing is pure logic, so it is worth pinning down: a wrong
// modifier bit or a silently accepted nonsense combo would only show up as "the
// shortcut does nothing".
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseHotkey } from '../hotkey.js'

const here = dirname(fileURLToPath(import.meta.url))
const results = []
let failures = 0

function ok(input, expected) {
  try {
    const combo = parseHotkey(input)
    const actual = { mods: combo.mods, vk: combo.vk, label: combo.label }
    const matches = JSON.stringify(actual) === JSON.stringify(expected)
    if (!matches) failures += 1
    results.push(`${matches ? 'PASS' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(actual)}${matches ? '' : ` expected ${JSON.stringify(expected)}`}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL ${JSON.stringify(input)} threw ${error.message}`)
  }
}

function rejects(input) {
  try {
    parseHotkey(input)
    failures += 1
    results.push(`FAIL ${JSON.stringify(input)} was accepted but should be rejected`)
  } catch (error) {
    results.push(`PASS ${JSON.stringify(input)} rejected: ${error.message}`)
  }
}

ok('ctrl+alt+q', { mods: 0x0003, vk: 0x51, label: 'Ctrl+Alt+Q' })
ok('CTRL+ALT+Q', { mods: 0x0003, vk: 0x51, label: 'Ctrl+Alt+Q' })
ok('Ctrl + Alt + Q', { mods: 0x0003, vk: 0x51, label: 'Ctrl+Alt+Q' })
ok('control+shift+f5', { mods: 0x0006, vk: 0x74, label: 'Ctrl+Shift+F5' })
ok('win+1', { mods: 0x0008, vk: 0x31, label: 'Win+1' })
ok('ctrl+space', { mods: 0x0002, vk: 0x20, label: 'Ctrl+Space' })
ok('alt+shift+f12', { mods: 0x0005, vk: 0x7B, label: 'Alt+Shift+F12' })
ok('meta+escape', { mods: 0x0008, vk: 0x1B, label: 'Win+Esc' })
ok('ctrl+alt+numpad5', { mods: 0x0003, vk: 0x65, label: 'Ctrl+Alt+Num5' })
rejects('q')
rejects('ctrl+alt')
rejects('ctrl+q+z')
rejects('')
rejects('ctrl+nosuchkey')

writeFileSync(join(here, 'parse-results.txt'), `${results.join('\n')}\n\nfailures=${failures}\n`, 'utf8')
