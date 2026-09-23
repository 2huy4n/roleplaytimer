import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)

const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}
offsets.push(buf.length)

let text = ''
let frames = 0
for (let i = 0; i < offsets.length - 1; i++) {
  try {
    text += zstdDecompressSync(buf.subarray(offsets[i], offsets[i + 1])).toString('utf8')
    frames += 1
  } catch { /* magic byte inside a frame payload */ }
}

const lines = text.split('\n').filter(Boolean)
const types = {}
for (const l of lines) { try { const j = JSON.parse(l); types[j.type] = (types[j.type] || 0) + 1 } catch {} }
console.log('frames', frames, 'lines', lines.length)
console.log('TYPES ' + JSON.stringify(types))
const um = lines.filter((l) => { try { return JSON.parse(l).type === 'user/message' } catch { return false } })
console.log('user/message count ' + um.length)
if (um.length) {
  console.log('FIRST ' + um[0].slice(0, 500))
  console.log('LAST ' + um[um.length - 1].slice(0, 500))
}
