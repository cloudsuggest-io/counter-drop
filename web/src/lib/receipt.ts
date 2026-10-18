// Receipt as a PNG the customer can save or share (WhatsApp, Telegram, email …). Drawn on a canvas
// with the app's own fonts, so Hindi and Marathi render the same on every phone; no PDF library.
// Design: brand header, the token as the hero, amounts, deletion proof, and a footer with a QR and
// link that open Counter Drop, so whoever receives the image can start using it.

import QRCode from 'qrcode' // already in the app bundle (the shop's QR kit uses it)

export interface ReceiptData {
  title: string // "Receipt"
  shopName: string
  shopAddress?: string
  token: string
  status: string // "Collected"
  when: string // collected date and time
  files: { name: string; detail: string }[]
  rows: { label: string; value: string }[] // amount lines before the total
  total: { label: string; value: string }
  paid: { label: string; value: string }
  notes: { label: string; value: string }[] // deletion proof
  appUrl: string // opens the app (and lets people install it)
  tagline: string // one line under the QR: why to open the link
  footer: string // small print: receipt ID
}

const SANS = '"Noto Sans", "Noto Sans Devanagari", system-ui, sans-serif'
const MONO = '"JetBrains Mono", ui-monospace, monospace'
const W = 600 // CSS pixels; drawn at 2× for sharp text
const PAD = 32

// Brand colours (design system)
const INK = '#0F172A'
const MUTED = '#475569'
const LINE = '#E2E8F0'
const TINT = '#EFF4FF'
const ACTION = '#2563EB'
const SKY = '#38BDF8'
const READY = '#15803D'
const READY_BG = '#DCFCE7'
const PAPER = '#FFFFFF'

// The Counter Drop drop mark (same outline as the app icon), in its own 192×240 box.
const DROP = 'M 96 0 C 85 18 45 78 25 125 C 14 151 14 180 30 204 C 44 226 68 240 96 240 C 124 240 148 226 162 204 C 178 180 178 151 167 125 C 147 78 107 18 96 0 Z'

type QR = { size: number; get: (r: number, c: number) => boolean }

export async function receiptBlob(d: ReceiptData): Promise<Blob> {
  try {
    await document.fonts?.ready
  } catch {
    /* fonts API not available: system fonts are fine */
  }
  const qr = makeQr(d.appUrl)
  // Two passes: measure the height, then draw.
  const height = draw(null, d, qr)
  const canvas = document.createElement('canvas')
  canvas.width = W * 2
  canvas.height = height * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas not available')
  ctx.scale(2, 2)
  draw(ctx, d, qr)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not create image'))), 'image/png'))
}

export async function downloadReceipt(d: ReceiptData, filename: string) {
  saveBlob(await receiptBlob(d), filename)
}

export type ShareResult = 'shared' | 'copied' | 'downloaded' | 'cancelled'

/**
 * Shares the receipt the way people expect from other apps: the image with a ready-written message
 * (WhatsApp shows the message as the image caption). Falls back to sharing the message alone, and
 * on desktop to downloading the image and copying the message.
 */
export async function shareReceipt(d: ReceiptData | null, text: string, filename: string): Promise<ShareResult> {
  try {
    if (d) {
      const blob = await receiptBlob(d)
      const file = new File([blob], filename, { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text, title: d.title })
        return 'shared'
      }
      if (!navigator.share) {
        saveBlob(blob, filename)
        await copy(text)
        return 'downloaded'
      }
    }
    if (navigator.share) {
      await navigator.share({ text })
      return 'shared'
    }
    await copy(text)
    return 'copied'
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return 'cancelled' // closed the share sheet
    throw e
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard blocked: the image was still saved */
  }
}

function makeQr(url: string): QR | null {
  try {
    const m = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules
    return { size: m.size, get: (r, c) => Boolean(m.get(r, c)) }
  } catch {
    return null // no QR: the link is still printed
  }
}

/** Draws the receipt (or only measures it when ctx is null) and returns its height. */
function draw(ctx: CanvasRenderingContext2D | null, d: ReceiptData, qr: QR | null): number {
  const m = ctx ?? measureCtx()
  let y = 0

  const font = (size: number, bold = false, mono = false) => `${bold ? 700 : 400} ${size}px ${mono ? MONO : SANS}`
  const text = (s: string, x: number, yy: number, size: number, o: { bold?: boolean; mono?: boolean; colour?: string; align?: CanvasTextAlign; max?: number } = {}) => {
    m.font = font(size, o.bold, o.mono)
    m.textAlign = o.align ?? 'left'
    m.textBaseline = 'alphabetic'
    m.fillStyle = o.colour ?? INK
    const v = o.max ? fit(m, s, o.max) : s
    if (ctx) ctx.fillText(v, x, yy)
    return m.measureText(v).width
  }
  const box = (x: number, yy: number, w: number, h: number, colour: string, r = 0) => {
    if (!ctx) return
    ctx.fillStyle = colour
    ctx.beginPath()
    if (r) ctx.roundRect(x, yy, w, h, r)
    else ctx.rect(x, yy, w, h)
    ctx.fill()
  }
  const rule = (yy: number) => box(PAD, yy, W - 2 * PAD, 1, LINE)

  // Paper
  if (ctx) box(0, 0, W, 20_000, PAPER)

  // ── Header band ─────────────────────────────────────────────
  const HEAD = 96
  box(0, 0, W, HEAD, INK)
  if (ctx) {
    ctx.save()
    ctx.translate(PAD, 22)
    ctx.scale(52 / 240, 52 / 240)
    ctx.fillStyle = ACTION
    ctx.fill(new Path2D(DROP))
    ctx.fillStyle = PAPER
    ctx.fillRect(70, 110, 52, 66) // the page inside the drop
    ctx.fillStyle = SKY
    ctx.fillRect(80, 126, 28, 8)
    ctx.restore()
  }
  text('Counter Drop', PAD + 56, 50, 22, { bold: true, colour: PAPER })
  text('INSTANT PRINT WORKFLOW', PAD + 56, 70, 10, { mono: true, colour: '#94A3B8' })
  // Title chip on the right
  m.font = font(14, true)
  const chipW = m.measureText(d.title).width + 28
  box(W - PAD - chipW, 32, chipW, 32, ACTION, 16)
  text(d.title, W - PAD - chipW / 2, 53, 14, { bold: true, colour: PAPER, align: 'center' })
  y = HEAD

  // ── Shop ───────────────────────────────────────────────────
  y += 44
  text(d.shopName, PAD, y, 24, { bold: true, max: W - 2 * PAD })
  if (d.shopAddress) {
    y += 22
    text(d.shopAddress, PAD, y, 14, { colour: MUTED, max: W - 2 * PAD })
  }

  // ── Token card ─────────────────────────────────────────────
  y += 22
  const CARD = 112
  box(PAD, y, W - 2 * PAD, CARD, TINT, 14)
  text('TOKEN', PAD + 22, y + 32, 12, { bold: true, mono: true, colour: MUTED })
  text(d.token || '—', PAD + 20, y + 88, 52, { bold: true, mono: true })
  // Status chip + time on the right
  m.font = font(14, true)
  const sW = m.measureText(d.status).width + 44
  const sx = W - PAD - 20 - sW
  box(sx, y + 24, sW, 30, READY_BG, 15)
  if (ctx) {
    ctx.strokeStyle = READY
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(sx + 13, y + 39)
    ctx.lineTo(sx + 18, y + 44)
    ctx.lineTo(sx + 27, y + 34)
    ctx.stroke()
  }
  text(d.status, sx + 33, y + 44, 14, { bold: true, colour: READY })
  text(d.when, W - PAD - 20, y + 84, 14, { colour: MUTED, align: 'right', max: 240 })
  y += CARD

  // ── Files ──────────────────────────────────────────────────
  y += 18
  for (const f of d.files) {
    y += 30
    box(PAD, y - 17, 16, 20, LINE, 3) // little page icon
    box(PAD + 4, y - 11, 8, 2, ACTION)
    text(f.name, PAD + 28, y, 16, { bold: true, max: W - 2 * PAD - 220 })
    text(f.detail, W - PAD, y, 14, { align: 'right', colour: MUTED, max: 190 })
  }
  y += 22
  rule(y)

  // ── Amounts ────────────────────────────────────────────────
  const pair = (label: string, value: string) => {
    y += 30
    text(label, PAD, y, 16, { colour: MUTED, max: W - 2 * PAD - 220 })
    text(value, W - PAD, y, 16, { align: 'right', max: 260 })
  }
  for (const r of d.rows) pair(r.label, r.value)
  y += 18
  box(PAD, y, W - 2 * PAD, 52, INK, 10)
  text(d.total.label, PAD + 18, y + 33, 17, { bold: true, colour: PAPER, max: W - 2 * PAD - 220 })
  text(d.total.value, W - PAD - 18, y + 35, 26, { bold: true, mono: true, colour: PAPER, align: 'right' })
  y += 52
  pair(d.paid.label, d.paid.value)

  // ── Deletion proof ─────────────────────────────────────────
  if (d.notes.length) {
    y += 22
    m.font = font(15)
    const lines = d.notes.map((n) => ({ label: n.label, lines: wrap(m, n.value, W - 2 * PAD - 72) }))
    const h = 24 + lines.reduce((s, n) => s + 22 + n.lines.length * 21 + 8, 0)
    box(PAD, y, W - 2 * PAD, h, READY_BG, 12)
    // shield
    if (ctx) {
      ctx.save()
      ctx.translate(PAD + 18, y + 18)
      ctx.fillStyle = READY
      ctx.beginPath()
      ctx.moveTo(14, 0)
      ctx.lineTo(28, 5)
      ctx.lineTo(28, 15)
      ctx.quadraticCurveTo(28, 28, 14, 34)
      ctx.quadraticCurveTo(0, 28, 0, 15)
      ctx.lineTo(0, 5)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = PAPER
      ctx.lineWidth = 2.6
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(8, 17)
      ctx.lineTo(12.5, 21.5)
      ctx.lineTo(20, 13)
      ctx.stroke()
      ctx.restore()
    }
    let yy = y + 12
    for (const n of lines) {
      yy += 22
      text(n.label, PAD + 60, yy, 13, { bold: true, colour: READY })
      for (const l of n.lines) {
        yy += 21
        text(l, PAD + 60, yy, 15)
      }
      yy += 8
    }
    y += h
  }

  // ── Torn edge + footer with QR and link ────────────────────
  y += 30
  const FOOT = qr ? 150 : 104
  const ZIG = 10
  box(0, y + ZIG, W, FOOT, INK)
  if (ctx) {
    ctx.fillStyle = INK
    ctx.beginPath()
    ctx.moveTo(0, y + ZIG)
    for (let x = 0; x <= W; x += ZIG * 2) {
      ctx.lineTo(x + ZIG, y)
      ctx.lineTo(x + ZIG * 2, y + ZIG)
    }
    ctx.lineTo(W, y + ZIG + 1)
    ctx.lineTo(0, y + ZIG + 1)
    ctx.closePath()
    ctx.fill()
  }
  const fy = y + ZIG + 24
  let tx = PAD
  if (qr) {
    const Q = 102
    box(PAD, fy, Q, Q, PAPER, 8)
    if (ctx) {
      const quiet = 6
      const cell = (Q - quiet * 2) / qr.size
      ctx.fillStyle = INK
      for (let r = 0; r < qr.size; r++)
        for (let c = 0; c < qr.size; c++) if (qr.get(r, c)) ctx.fillRect(PAD + quiet + c * cell, fy + quiet + r * cell, Math.ceil(cell), Math.ceil(cell))
    }
    tx = PAD + Q + 22
  }
  const tw = W - PAD - tx
  m.font = font(17, true)
  const tag = wrap(m, d.tagline, tw).slice(0, 2)
  let ty = fy + 22
  for (const l of tag) {
    text(l, tx, ty, 17, { bold: true, colour: PAPER })
    ty += 24
  }
  text(d.appUrl.replace(/^https?:\/\//, '').replace(/\/?\?.*$/, ''), tx, ty + 4, 15, { bold: true, mono: true, colour: SKY, max: tw })
  text(d.footer, tx, ty + 30, 11, { mono: true, colour: '#94A3B8', max: tw })
  y += ZIG + FOOT
  return y
}

let measurer: CanvasRenderingContext2D | null = null
function measureCtx(): CanvasRenderingContext2D {
  if (!measurer) measurer = document.createElement('canvas').getContext('2d')!
  return measurer
}

/** Shortens text with an ellipsis to fit a width. */
function fit(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s
  const chars = Array.from(s)
  while (chars.length > 1 && ctx.measureText(chars.join('') + '…').width > max) chars.pop()
  return chars.join('') + '…'
}

/** Splits text into lines that fit a width (breaks on spaces; very long words are cut). */
function wrap(ctx: CanvasRenderingContext2D, s: string, max: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of s.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w
    if (ctx.measureText(next).width <= max || !cur) cur = next
    else {
      out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  return out.map((l) => fit(ctx, l, max))
}
