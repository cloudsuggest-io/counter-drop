import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Download, Moon, RefreshCw, Sun } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useLive, type LiveTicket } from '@/lib/live'
import { rupees } from '@/lib/format'
import type { Dashboard } from '@/lib/types'
import { Banner, Spinner } from '@/components/ui'
import { useShopAuth, useShopTheme } from './auth'

type Days = 1 | 7 | 30
const PERIODS: { value: Days; label: string }[] = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
]

const IST = 'Asia/Kolkata'
const headerDate = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: IST })
const headerTime = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST })
const dayShort = new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' })
const dayNum = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const num = new Intl.NumberFormat('en-IN')

const lower = (s: string) => s.replace('AM', 'am').replace('PM', 'pm')
const asDate = (day: string) => new Date(day + 'T12:00:00Z')

/** Whole-rupee money for big numbers ("₹1,240"). */
const money = (paise: number) => rupees(Math.round(paise / 100) * 100)

function minutes(sec: number): string {
  if (sec <= 0) return '—'
  if (sec < 60) return `${sec} s`
  const m = Math.round(sec / 60)
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`
}

function hourLabel(h: number): string {
  const s = h >= 12 ? 'p' : 'a'
  return `${h % 12 === 0 ? 12 : h % 12}${s}`
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev <= 0) return cur > 0 ? <span className="text-sm font-bold text-ink-muted">new</span> : null
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (pct === 0) return <span className="text-sm font-bold text-ink-muted">= same</span>
  const up = pct > 0
  return (
    <span className={`text-sm font-bold ${up ? 'text-ready' : 'text-danger'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  )
}

function Panel({ title, right, children, className = '' }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col gap-3 rounded border-[1.5px] border-line bg-surface p-4 ${className}`}>
      {(title || right) && (
        <div className="flex items-baseline justify-between gap-2">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {right && <span className="text-xs text-ink-muted">{right}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

function Kpi({ label, value, sub, subTone, valueTone }: { label: string; value: string; sub?: React.ReactNode; subTone?: string; valueTone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded border-[1.5px] border-line bg-surface p-3.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</span>
      <span className={`font-mono text-[28px] font-bold leading-tight tabular-nums ${valueTone ?? ''}`}>{value}</span>
      {sub && <span className={`text-xs ${subTone ?? 'text-ink-muted'}`}>{sub}</span>}
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-muted">{label}</span>
      <b className={`font-mono tabular-nums ${tone ?? ''}`}>{value}</b>
    </div>
  )
}

/** Splits a total into proportional segments for the little stacked bars. */
function Split({ parts, label }: { parts: { value: number; className: string }[]; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  return (
    <div role="img" aria-label={label} className="flex h-2 overflow-hidden rounded bg-divider">
      {total > 0 && parts.map((p, i) => p.value > 0 && <div key={i} className={p.className} style={{ width: `${(p.value / total) * 100}%` }} />)}
    </div>
  )
}

function csvFor(d: Dashboard, shopName: string): string {
  const q = (v: string | number) => (typeof v === 'number' ? String(v) : `"${v.replace(/"/g, '""')}"`)
  const r = (paise: number) => (paise / 100).toFixed(2)
  const lines: (string | number)[][] = [
    ['Counter Drop dashboard', shopName],
    ['Period', `${d.from} to ${d.to}`],
    [],
    ['Earnings (₹)', r(d.earnings.totalPaise)],
    ['Cash (₹)', r(d.earnings.cashPaise)],
    ['UPI (₹)', r(d.earnings.upiPaise)],
    ['Not recorded (₹)', r(d.earnings.unrecordedPaise)],
    ['From orders (₹)', r(d.earnings.ordersPaise)],
    ['Order advances (₹)', r(d.orders.advancePaise)],
    ['Order balances (₹)', r(d.orders.balancePaise)],
    ['Order refunds (₹)', r(d.orders.refundPaise)],
    ['Orders: still to collect (₹)', r(d.orders.pendingPaise)],
    [`Earnings ${d.previous.label} (₹)`, r(d.previous.paise)],
    ['Jobs sent', d.jobs.submitted],
    ['Jobs collected', d.jobs.collected],
    ['Jobs cancelled', d.jobs.cancelled],
    ['Files', d.jobs.files],
    ['Pages printed', d.pages.printed],
    ['Sheets used', d.pages.sheets],
    ['B/W pages', d.pages.bw],
    ['Colour pages', d.pages.colour],
    ['Average wait (min)', Math.round(d.speed.waitSec / 60)],
    ['Average print (min)', Math.round(d.speed.printSec / 60)],
    ['Average pickup (min)', Math.round(d.speed.pickupSec / 60)],
    [],
    ['Day', 'Earnings (₹)', 'Jobs collected', 'Earnings, comparison day (₹)', 'Jobs, comparison day'],
    ...d.series.map((s) => [s.day, r(s.paise), s.jobs, r(s.prevPaise), s.prevJobs]),
    [],
    ['Staff', 'Jobs printed', 'Pages', 'Avg print (min)', 'Cash taken (₹)', 'UPI taken (₹)'],
    ...d.staff.map((s) => [s.name, s.jobs, s.pages, Math.round(s.avgPrintSec / 60), r(s.cashPaise), r(s.upiPaise)]),
  ]
  return lines.map((l) => l.map(q).join(',')).join('\r\n')
}

export default function DashboardPage() {
  const { session, call } = useShopAuth()
  const [dark, setDark] = useShopTheme()
  const [days, setDays] = useState<Days>(1)
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const daysRef = useRef(days)
  daysRef.current = days

  const load = useCallback(async () => {
    const want = daysRef.current
    setLoading(true)
    try {
      const d = await call<Dashboard>(`/shop/dashboard?days=${want}`)
      if (daysRef.current === want) {
        setData(d)
        setError('')
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Connection problem — showing the last numbers.')
    } finally {
      setLoading(false)
    }
  }, [call])

  useEffect(() => {
    load()
  }, [load, days])

  // The board's live stream tells us when something changed; refresh at most every few seconds.
  const pending = useRef<number | null>(null)
  const soon = useCallback(() => {
    if (pending.current !== null) return
    pending.current = window.setTimeout(() => {
      pending.current = null
      load()
    }, 4000)
  }, [load])
  useEffect(() => () => void (pending.current !== null && window.clearTimeout(pending.current)), [])
  const live = useMemo(
    () => (session ? { sse: `/shop/events?token=${encodeURIComponent(session.token)}`, ticket: () => call<LiveTicket>('/shop/live', { method: 'POST' }) } : null),
    [session, call],
  )
  useLive(live, soon, load, 60000)

  const shopName = session?.shop.name ?? 'Your shop'
  const downloadCsv = () => {
    if (!data) return
    const blob = new Blob(['﻿' + csvFor(data, shopName)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `counter-drop-${data.from}-to-${data.to}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b-[1.5px] border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/shop" className="rounded p-2 hover:bg-surface-tint" aria-label="Back to board" title="Back to board">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-base font-bold">{shopName}</div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ready">
              <span className="h-[7px] w-[7px] rounded-full bg-ready" aria-hidden />
              Live
              {data && (
                <span className="font-normal text-ink-muted">
                  · {headerDate.format(new Date(data.serverTime))}, {lower(headerTime.format(new Date(data.serverTime)))}
                </span>
              )}
              {loading && <RefreshCw className="h-3 w-3 animate-spin text-ink-muted" aria-label="Updating" />}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={downloadCsv} disabled={!data} className="rounded p-2 hover:bg-surface-tint disabled:opacity-40" aria-label="Download CSV" title="Download CSV">
              <Download className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => setDark(!dark)} className="rounded p-2 hover:bg-surface-tint" aria-label={dark ? 'Light theme' : 'Dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
              {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
          </div>
          <div role="group" aria-label="Period" className="grid w-full grid-cols-3 overflow-hidden rounded border-[1.5px] border-line sm:w-auto">
            {PERIODS.map((p, i) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={days === p.value}
                onClick={() => setDays(p.value)}
                className={`min-h-[44px] px-4 text-sm font-semibold ${i > 0 ? 'border-l-[1.5px] border-line' : ''} ${days === p.value ? 'bg-action text-white' : 'text-ink-muted hover:bg-surface-tint'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-3 p-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {!data ? (
          <div className="flex justify-center py-24">{error ? null : <Spinner className="h-8 w-8" />}</div>
        ) : (
          <Body d={data} />
        )}
      </main>
    </div>
  )
}

function Body({ d }: { d: Dashboard }) {
  const period = d.days === 1 ? 'today' : `last ${d.days} days`
  const e = d.earnings
  const sheetsNote = d.pages.sheets > 0 ? `≈ ${num.format(d.pages.sheets)} sheets of paper` : 'No pages printed yet'

  // Hours: show the working day, widened to wherever jobs actually came in.
  const busy = d.hours.filter((h) => h.jobs > 0 || h.prev > 0).map((h) => h.hour)
  const firstH = Math.min(9, ...busy)
  const lastH = Math.max(20, ...busy)
  const hours = d.hours.filter((h) => h.hour >= firstH && h.hour <= lastH)
  const hourMax = Math.max(1, ...hours.map((h) => Math.max(h.jobs, h.prev)))
  const peak = hours.reduce((a, h) => (h.jobs > a.jobs ? h : a), { hour: -1, jobs: 0, prev: 0 })

  const seriesMax = Math.max(1, ...d.series.map((s) => Math.max(s.paise, s.prevPaise)))
  const seriesTotal = d.series.reduce((s, x) => s + x.paise, 0)
  const seriesPrev = d.series.reduce((s, x) => s + x.prevPaise, 0)
  const lastIdx = d.series.length - 1
  const dense = d.series.length > 7

  const flow = d.speed.waitSec + d.speed.printSec + d.speed.pickupSec
  const staffTotal = d.staff.reduce(
    (a, s) => ({ jobs: a.jobs + s.jobs, pages: a.pages + s.pages, cash: a.cash + s.cashPaise, upi: a.upi + s.upiPaise }),
    { jobs: 0, pages: 0, cash: 0, upi: 0 },
  )
  const problems =
    d.now.copiesToConfirm + d.now.pagesToConfirm + e.unrecordedJobs + d.jobs.cancelled + d.problems.noReceipt + d.problems.longWaits

  return (
    <>
      {/* Top: money and the four numbers that matter most. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)]">
        <section className="flex flex-col gap-2 rounded border-[1.5px] border-line bg-surface p-4" aria-label="Earnings">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Earnings {period}</span>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[40px] font-bold leading-none tabular-nums">{money(e.totalPaise)}</span>
            <Delta cur={e.totalPaise} prev={d.previous.paise} />
          </div>
          <span className="text-xs text-ink-muted">
            vs {money(d.previous.paise)} {d.previous.label}
            {d.days === 1 ? ' (same time)' : ''}
            {e.ordersPaise !== 0 && <> · incl. {money(e.ordersPaise)} from orders</>}
          </span>
          <Split
            label={`Cash ${money(e.cashPaise)}, UPI ${money(e.upiPaise)}, not recorded ${money(e.unrecordedPaise)}`}
            parts={[
              { value: e.cashPaise, className: 'bg-ready' },
              { value: e.upiPaise, className: 'bg-action' },
              { value: e.unrecordedPaise, className: 'bg-ink-subtle' },
            ]}
          />
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-ink-muted">
            <span>
              <b className="text-ready">■</b> Cash {money(e.cashPaise)}
            </span>
            <span>
              <b className="text-action">■</b> UPI {money(e.upiPaise)}
            </span>
            <span>
              <b className="text-ink-subtle">■</b> Not recorded {money(e.unrecordedPaise)}
            </span>
          </div>
        </section>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi
            label="Jobs"
            value={num.format(d.jobs.submitted)}
            sub={d.jobs.collected > 0 ? `Avg bill ${money(d.jobs.avgBillPaise)} · top ${money(d.jobs.maxBillPaise)}` : `${num.format(d.jobs.files)} files`}
          />
          <Kpi label="Pages printed" value={num.format(d.pages.printed)} sub={sheetsNote} />
          <Kpi
            label="Average wait"
            value={minutes(d.speed.waitSec)}
            sub={d.speed.samples > 0 ? `${d.speed.withinTenPct}% ready within 10 min` : 'Nothing printed yet'}
          />
          <Kpi
            label="Ready now"
            value={num.format(d.now.ready)}
            valueTone={d.now.ready > 0 ? 'text-ready' : ''}
            sub={d.now.oldestReadyToken ? `${d.now.oldestReadyToken} waiting ${d.now.oldestReadyMin} min` : `${d.now.inLine} in line · ${d.now.printing} printing`}
            subTone={d.now.oldestReadyMin >= 30 ? 'text-attention' : undefined}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Busy hours */}
        <Panel title="Jobs by hour" right={peak.jobs > 0 ? `Peak ${hourLabel(peak.hour)}–${hourLabel(peak.hour + 1)}` : undefined} className="lg:col-span-2">
          <div
            role="img"
            aria-label={`Jobs per hour, ${period}${peak.jobs > 0 ? `, busiest ${hourLabel(peak.hour)} with ${peak.jobs}` : ''}`}
            className="grid h-[140px] items-end gap-1 border-b-[1.5px] border-line"
            style={{ gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))` }}
          >
            {hours.map((h) => (
              <div key={h.hour} className="relative flex h-[130px] flex-col justify-end" title={`${hourLabel(h.hour)}: ${h.jobs} (was ${h.prev})`}>
                {h.prev > 0 && <div className="absolute inset-x-0 border-t-2 border-dashed border-ink-subtle" style={{ bottom: `${(h.prev / hourMax) * 120}px` }} />}
                <div className={`rounded-t-sm ${h.hour === peak.hour && h.jobs > 0 ? 'bg-action' : 'bg-action opacity-60'}`} style={{ height: `${(h.jobs / hourMax) * 120}px` }} />
              </div>
            ))}
          </div>
          <div className="grid font-mono text-[11px] text-ink-muted" style={{ gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))` }}>
            {hours.map((h) => (
              <span key={h.hour} className="text-center">
                {h.hour % 3 === 0 ? hourLabel(h.hour) : ''}
              </span>
            ))}
          </div>
          <span className="text-xs text-ink-muted">Dashed line: {d.previous.label}</span>
        </Panel>

        {/* Right now */}
        <Panel title="Right now">
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { n: d.now.inLine, l: 'In line', tone: '' },
              { n: d.now.printing, l: 'Printing', tone: 'text-action' },
              { n: d.now.ready, l: 'Ready', tone: 'text-ready' },
            ].map((x) => (
              <div key={x.l} className="rounded bg-surface-tint py-3">
                <div className={`font-mono text-2xl font-bold ${x.tone}`}>{x.n}</div>
                <div className="text-xs text-ink-muted">{x.l}</div>
              </div>
            ))}
          </div>
          {d.now.oldestReadyToken && (
            <p className={`text-sm ${d.now.oldestReadyMin >= 30 ? 'text-attention' : 'text-ink-muted'}`}>
              <b className="font-mono">{d.now.oldestReadyToken}</b> ready for {d.now.oldestReadyMin} min · not picked up
            </p>
          )}
          <div className="space-y-1.5 border-t border-divider pt-3">
            <Row label="Copies to confirm deleting" value={d.now.copiesToConfirm} tone={d.now.copiesToConfirm ? 'text-attention' : ''} />
            <Row label="Pages to confirm" value={d.now.pagesToConfirm} tone={d.now.pagesToConfirm ? 'text-attention' : ''} />
            <Row label={`Files auto-deleted ${period}`} value={num.format(d.filesDeleted)} tone="text-ready" />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Staff */}
        <Panel title={`Staff ${period}`} className="lg:col-span-2">
          {d.staff.length === 0 ? (
            <p className="text-sm text-ink-muted">No jobs printed yet.</p>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                    <th className="px-1 pb-2 font-semibold">Name</th>
                    <th className="px-1 pb-2 text-right font-semibold">Jobs</th>
                    <th className="px-1 pb-2 text-right font-semibold">Pages</th>
                    <th className="hidden px-1 pb-2 text-right font-semibold sm:table-cell">Avg print</th>
                    <th className="px-1 pb-2 text-right font-semibold">Cash</th>
                    <th className="hidden px-1 pb-2 text-right font-semibold sm:table-cell">UPI</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {d.staff.map((s) => (
                    <tr key={s.name} className="border-t border-divider">
                      <td className="px-1 py-2 font-sans font-semibold">{s.name}</td>
                      <td className="px-1 py-2 text-right">{s.jobs}</td>
                      <td className="px-1 py-2 text-right">{num.format(s.pages)}</td>
                      <td className="hidden px-1 py-2 text-right sm:table-cell">{minutes(s.avgPrintSec)}</td>
                      <td className="px-1 py-2 text-right">{money(s.cashPaise)}</td>
                      <td className="hidden px-1 py-2 text-right sm:table-cell">{money(s.upiPaise)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-[1.5px] border-line font-bold">
                    <td className="px-1 py-2 font-sans">Total</td>
                    <td className="px-1 py-2 text-right">{staffTotal.jobs}</td>
                    <td className="px-1 py-2 text-right">{num.format(staffTotal.pages)}</td>
                    <td className="hidden px-1 py-2 text-right sm:table-cell">{minutes(d.speed.printSec)}</td>
                    <td className="px-1 py-2 text-right">{money(staffTotal.cash)}</td>
                    <td className="hidden px-1 py-2 text-right sm:table-cell">{money(staffTotal.upi)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-ink-muted">Cash = jobs each person marked collected as cash. Use it to match the till at closing.</p>
        </Panel>

        {/* What people printed */}
        <Panel title="What people printed">
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span>
                B/W <b className="font-mono">{num.format(d.pages.bw)}</b>
              </span>
              <span>
                Colour <b className="font-mono">{num.format(d.pages.colour)}</b>
              </span>
            </div>
            <Split label="Black and white versus colour pages" parts={[{ value: d.pages.bw, className: 'bg-ink-subtle' }, { value: d.pages.colour, className: 'bg-action' }]} />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span>
                One side <b className="font-mono">{num.format(d.pages.oneSide)}</b>
              </span>
              <span>
                Both sides <b className="font-mono">{num.format(d.pages.bothSides)}</b>
              </span>
            </div>
            <Split label="One side versus both sides" parts={[{ value: d.pages.oneSide, className: 'bg-ink-subtle' }, { value: d.pages.bothSides, className: 'bg-ready' }]} />
          </div>
          <div className="space-y-1.5 border-t border-divider pt-3">
            <Row label="PDF files" value={num.format(d.pages.pdfFiles)} />
            <Row label="Photos" value={num.format(d.pages.photoFiles)} />
            <Row label="Word, Excel & other documents" value={num.format(d.pages.docFiles)} />
            <Row label="Other services (lamination, forms…)" value={`${d.pages.otherFiles} · ${money(d.pages.otherPaise)}`} />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Earnings by day */}
        <Panel
          title={d.days === 30 ? 'Last 30 days vs the 30 before' : 'This week vs last week'}
          right={
            <span className="text-[13px] text-ink">
              <b className="font-mono">{money(seriesTotal)}</b> <Delta cur={seriesTotal} prev={seriesPrev} />
            </span>
          }
          className="lg:col-span-2"
        >
          <div
            role="img"
            aria-label={`Earnings per day, ${d.series.length} days, compared with the period before`}
            className={`grid h-[120px] items-end border-b-[1.5px] border-line ${dense ? 'gap-0.5' : 'gap-2'}`}
            style={{ gridTemplateColumns: `repeat(${d.series.length}, minmax(0, 1fr))` }}
          >
            {d.series.map((s, i) => (
              <div key={s.day} className="flex h-full items-end justify-center gap-0.5" title={`${dayNum.format(asDate(s.day))}: ${money(s.paise)} (was ${money(s.prevPaise)})`}>
                <div className="w-[42%] rounded-t-sm bg-ink-subtle opacity-50" style={{ height: `${(s.prevPaise / seriesMax) * 110}px` }} />
                <div className={`w-[42%] rounded-t-sm ${i === lastIdx ? 'bg-action' : 'bg-action opacity-75'}`} style={{ height: `${(s.paise / seriesMax) * 110}px` }} />
              </div>
            ))}
          </div>
          <div className={`grid text-center text-[11px] text-ink-muted ${dense ? 'gap-0.5' : 'gap-2'}`} style={{ gridTemplateColumns: `repeat(${d.series.length}, minmax(0, 1fr))` }}>
            {d.series.map((s, i) => (
              <span key={s.day} className="truncate">
                {i === lastIdx ? 'Today' : dense ? (i % 5 === lastIdx % 5 ? dayNum.format(asDate(s.day)) : '') : dayShort.format(asDate(s.day))}
              </span>
            ))}
          </div>
          <span className="text-xs text-ink-muted">Grey: {d.days === 30 ? '30 days earlier' : 'same day last week'} · blue: {d.days === 30 ? 'last 30 days' : 'this week'}</span>
        </Panel>

        {/* Speed */}
        <Panel title="How fast, on average">
          <Split
            label="Time split between waiting in line, printing and waiting for pickup"
            parts={[
              { value: d.speed.waitSec, className: 'bg-attention' },
              { value: d.speed.printSec, className: 'bg-action' },
              { value: d.speed.pickupSec, className: 'bg-ready' },
            ]}
          />
          <div className="space-y-1.5">
            <Row label="■ Waiting in line" value={minutes(d.speed.waitSec)} tone="text-attention" />
            <Row label="■ Printing" value={minutes(d.speed.printSec)} tone="text-action" />
            <Row label="■ Waiting for pickup" value={minutes(d.speed.pickupSec)} tone="text-ready" />
          </div>
          {flow > 0 && (
            <p className="text-xs text-ink-muted">
              Sent to collected: {minutes(flow)}.
              {d.speed.pickupSec > d.speed.waitSec + d.speed.printSec ? ' Most of it is customers coming back later, not the counter.' : ''}
            </p>
          )}
        </Panel>
      </div>

      {/* Orders that take days: money taken in the period, and the open book right now */}
      {(d.orders.open > 0 || d.orders.advancePaise > 0 || d.orders.balancePaise > 0 || d.orders.refundPaise > 0) && (
        <Panel
          title="Orders (blackbooks, binding, cards…)"
          right={
            <Link to="/shop/orders" className="font-semibold text-action hover:underline">
              Open orders →
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded bg-surface-tint p-3">
              <div className="text-xs text-ink-muted">Advances {period}</div>
              <div className="font-mono text-xl font-bold">{money(d.orders.advancePaise)}</div>
            </div>
            <div className="rounded bg-surface-tint p-3">
              <div className="text-xs text-ink-muted">Balances {period}</div>
              <div className="font-mono text-xl font-bold">{money(d.orders.balancePaise)}</div>
            </div>
            <div className="rounded bg-surface-tint p-3">
              <div className="text-xs text-ink-muted">Still to collect</div>
              <div className={`font-mono text-xl font-bold ${d.orders.pendingPaise > 0 ? 'text-attention' : ''}`}>{money(d.orders.pendingPaise)}</div>
            </div>
            <div className="rounded bg-surface-tint p-3">
              <div className="text-xs text-ink-muted">Open orders</div>
              <div className="font-mono text-xl font-bold">{d.orders.open}</div>
            </div>
          </div>
          <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4">
            <Row label="Need a price" value={d.orders.needQuote} tone={d.orders.needQuote ? 'text-attention' : ''} />
            <Row label="Due today" value={d.orders.dueToday} tone={d.orders.dueToday ? 'text-action' : ''} />
            <Row label="Late" value={d.orders.overdue} tone={d.orders.overdue ? 'text-danger' : ''} />
            <Row label="Ready for pickup" value={d.orders.ready} tone={d.orders.ready ? 'text-ready' : ''} />
          </div>
          {d.orders.refundPaise > 0 && <p className="text-xs text-ink-muted">Refunded {period}: {money(d.orders.refundPaise)} (already taken off the earnings).</p>}
        </Panel>
      )}

      {/* Needs a look */}
      <Panel title="Needs a look" right={problems === 0 ? 'All clear' : undefined}>
        <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Payment not recorded" value={e.unrecordedJobs ? `${e.unrecordedJobs} · ${money(e.unrecordedPaise)}` : 0} tone={e.unrecordedJobs ? 'text-attention' : ''} />
          <Row label="Copies to confirm deleting" value={d.now.copiesToConfirm} tone={d.now.copiesToConfirm ? 'text-attention' : ''} />
          <Row label="Waited over 15 min" value={d.problems.longWaits} tone={d.problems.longWaits ? 'text-attention' : ''} />
          <Row label="Cancelled by customer" value={d.problems.cancelledByCustomer} />
          <Row label="Cancelled by shop" value={d.problems.cancelledByShop} />
          <Row label="Not collected" value={d.problems.notCollected} tone={d.problems.notCollected ? 'text-attention' : ''} />
          <Row label="Collected without receipt" value={d.problems.noReceipt} />
        </div>
        {d.problems.longWaits > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-attention">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Long waits usually mean one counter is busy — try Rush mode at peak hours.
          </p>
        )}
      </Panel>
    </>
  )
}
