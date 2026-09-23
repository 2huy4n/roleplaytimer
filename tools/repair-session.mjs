// Repair a session log corrupted by roleplaytimer <= 0.1.0.
//
// Those builds called agent.followup({ content, source }) instead of a complete
// UserMessage, so the appended `user/message` event had no `id`/`role` and the
// whole session failed validation on the next load (seq 760 of session-08147538).
//
// Usage: node tools/repair-session.mjs <session.v3.jsonl.zstd> <seq>
// Writes a .bak-roleplaytimer-<timestamp> copy next to the file, recompresses
// only the frame holding the event, then re-validates every message event.
//
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/repair-session.mjs <session.v3.jsonl.zstd> <seq>')
  process.exit(2)
}
const seq = Number(process.argv[3] || 760)
const buf = readFileSync(file)
const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) if (buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd) offsets.push(i)
offsets.push(buf.length)

const chunks = []
let patched = 0
let recompressed = 0
for (let i=0;i<offsets.length-1;i++){
  const start = offsets[i], end = offsets[i+1]
  const raw = buf.subarray(start, end)
  let text
  try { text = zstdDecompressSync(raw).toString('utf8') } catch { chunks.push(raw); continue }
  const lines = text.split('\n')
  let changed = false
  for (let j=0;j<lines.length;j++){
    const line = lines[j]
    if (!line) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o && o.type === 'user/message' && Number(o.seq) === seq && o.data && typeof o.data.id !== 'string') {
      o.data = { ...o.data, role: 'user', id: randomUUID() }
      lines[j] = JSON.stringify(o)
      changed = true
      patched++
    }
  }
  if (changed) { chunks.push(zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))); recompressed++ }
  else chunks.push(raw)
}
if (patched !== 1) { console.log('ABORT: patched', patched); process.exit(1) }

const backup = file + '.bak-roleplaytimer-' + new Date().toISOString().replace(/[:.]/g,'-')
copyFileSync(file, backup)
writeFileSync(file, Buffer.concat(chunks))
console.log('patched lines', patched, 'recompressed frames', recompressed, 'total frames', offsets.length-1)
console.log('backup', backup)

// --- verify against the same invariants the loader uses ---
function validate(path) {
  const b = readFileSync(path)
  const offs = []
  for (let i=0;i+4<=b.length;i++) if (b[i]===0x28&&b[i+1]===0xb5&&b[i+2]===0x2f&&b[i+3]===0xfd) offs.push(i)
  offs.push(b.length)
  const events = []
  let framesOk = 0
  for (let i=0;i<offs.length-1;i++){
    try { const t = zstdDecompressSync(b.subarray(offs[i],offs[i+1])).toString('utf8'); framesOk++; for (const l of t.split('\n')) { if (!l) continue; try { events.push(JSON.parse(l)) } catch {} } } catch {}
  }
  const roles = { 'system/message':'system', 'user/message':'user', 'assistant/message':'assistant', 'tool/result':'user' }
  const problems = []
  for (const e of events) {
    const want = roles[e.type]
    if (!want) continue
    const d = e.data
    const rec = d && typeof d === 'object' ? d : undefined
    const m = e.type === 'user/message' ? rec : rec && rec.message
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '') { problems.push(['id', e.type, e.seq]); continue }
    if (m.role !== want) { problems.push(['role', e.type, e.seq, m.role]); continue }
    if (!m.source || typeof m.source.kind !== 'string' || m.source.kind === '') { problems.push(['source', e.type, e.seq]); continue }
    if (!Array.isArray(m.content)) problems.push(['content', e.type, e.seq])
  }
  return { frames: offs.length-1, framesOk, events: events.length, problems, maxSeq: Math.max(...events.map(x=>Number(x.seq)).filter(Number.isFinite)) }
}
console.log('VERIFY', JSON.stringify(validate(file)))
