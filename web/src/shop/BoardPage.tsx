import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, BookOpen, Check, Download, ExternalLink, FileCheck2, FilePlus2, LogOut, ReceiptText, Moon, Play, Printer, QrCode, RotateCcw, Search, Settings, Sun, Undo2, UserRound, Volume2, VolumeX, X, Zap } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { chime, useLive, type LiveTicket } from '@/lib/live'
import { clock, dayTime, minutesSince, mmss, rupees } from '@/lib/format'
import type { Job, JobFile, JobState, OnlineState, OrdersSnapshot, PriceList, QueueSnapshot } from '@/lib/types'
import { browserPrintable } from '@/lib/upload'
import { Banner, Button, Chip, Logo, Spinner } from '@/components/ui'
import { useShopAuth, useShopTheme } from './auth'

type Column = { key: string; title: string; states: JobState[] }
const COLUMNS: Column[] = [
  { key: 'queued', title: 'In line', states: ['queued'] },
  { key: 'claimed', title: 'Printing', states: ['claimed'] },
  { key: 'ready', title: 'Ready', states: ['ready'] },
  { key: 'collected', title: 'Collected · undo 10 min', states: ['collected'] },
]

const CANCEL_REASONS = [
  ['file_problem', "File won't open or print"],
  ['customer_request', 'Customer asked to cancel'],
  ['duplicate', 'Sent twice'],
  ['other', 'Other'],
] as const

function settingsSummary(j: Job): string {
  const printed = j.files.filter((x) => !x.settings.other)
  const f = printed[0]?.settings
  if (!f) return 'Other only'
  const multi = printed.some((x) => x.settings.colour !== f.colour || x.settings.bothSides !== f.bothSides || x.settings.copies !== f.copies)
  if (multi) return 'Mixed settings'
  return [f.colour ? 'Colour' : 'B/W', f.bothSides ? 'both sides' : 'one side', f.copies > 1 ? `×${f.copies}` : ''].filter(Boolean).join(' · ')
}

/** Files sent for something other than printing; the shop prices them when marking the job ready. */
const otherFiles = (j: Job) => j.files.filter((f) => f.settings.other && f.deleteStatus === 'active')
const needsOtherPrice = (j: Job) => j.otherPricePaise === undefined && j.files.some((f) => f.settings.other)

/** Price as the shop sees it: "₹6 + ?" until the Other files are priced. */
function priceLabel(j: Job): string {
  if (j.pagesToConfirm) return '₹ ?'
  return needsOtherPrice(j) ? `${rupees(j.priceTotalPaise)} + ?` : rupees(j.priceTotalPaise)
}

/** Printed files whose pages the phone couldn't count (Word, Excel…): staff enter them on Ready. */
const pagesNeeded = (j: Job) => j.files.filter((f) => !f.settings.other && f.deleteStatus === 'active' && f.pages <= 0)
const needsReadyDialog = (j: Job) => needsOtherPrice(j) || (j.pagesToConfirm && pagesNeeded(j).length > 0)

/** How many pages a range like "1-3,5" selects out of n (empty = all). Mirrors domain.ParsePageRange. */
function selectedPages(expr: string | undefined, n: number): number {
  const e = (expr ?? '').replace(/\s/g, '')
  if (!e) return n
  const set = new Set<number>()
  for (const part of e.split(',')) {
    const [a = 0, b = a] = part.split('-').map(Number)
    for (let p = a; p <= b && p <= n; p++) if (p >= 1) set.add(p)
  }
  return set.size
}

/** Estimate of the printed-files price with the entered page counts. The server reprices on Ready. */
function estimatePaise(pl: PriceList, files: JobFile[], entered: Record<string, number>): number {
  let total = 0
  for (const f of files) {
    if (f.settings.other || f.deleteStatus !== 'active') continue
    const pages = f.pages > 0 ? f.pages : entered[f.id] ?? 0
    const n = selectedPages(f.settings.pageRange, pages)
    const one = f.settings.colour ? pl.colourOnePaise : pl.bwOnePaise
    let both = f.settings.colour ? pl.colourBothPaise : pl.bwBothPaise
    if (both === 0) both = 2 * one
    total += f.settings.bothSides ? f.settings.copies * Math.ceil(n / 2) * both : f.settings.copies * n * one
  }
  if (total > 0 && total < pl.minChargePaise) total = pl.minChargePaise
  return Math.round(total / 100) * 100
}

type ActBody = Record<string, unknown>

export default function BoardPage() {
  const { session, call, logout, setShop } = useShopAuth()
  const [dark, setDark] = useShopTheme()
  const [snap, setSnap] = useState<QueueSnapshot | null>(null)
  const [ordersNeedingPrice, setOrdersNeedingPrice] = useState(0)
  const [lane, setLane] = useState<string>('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [copiesOpen, setCopiesOpen] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [sound, setSound] = useState(true)
  const [rush, setRush] = useState(false)
  const [mobileCol, setMobileCol] = useState('queued')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Job[] | null>(null)
  const [now, setNow] = useState(Date.now())
  const [pricing, setPricing] = useState<Job | null>(null) // Ready on a job with Other files or uncounted pages: ask first
  const [noReceipt, setNoReceipt] = useState<Record<string, boolean>>({}) // per job; receipts are on by default
  const known = useRef<Set<string> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const soundRef = useRef(sound)
  soundRef.current = sound

  const load = useCallback(async () => {
    try {
      const q = await call<QueueSnapshot>('/shop/queue')
      const queuedIds = new Set(q.jobs.filter((j) => j.state === 'queued').map((j) => j.id))
      if (known.current && soundRef.current && [...queuedIds].some((id) => !known.current!.has(id))) chime('soft')
      known.current = new Set(q.jobs.map((j) => j.id))
      setSnap(q)
      setShop(q.shop)
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Connection problem — showing the last queue.')
    }
  }, [call, setShop])

  const loadOrderAlerts = useCallback(async () => {
    try {
      const orders = await call<OrdersSnapshot>('/shop/orders')
      setOrdersNeedingPrice(orders.open.filter((o) => o.state === 'requested').length)
    } catch {
      // Keep the last known badge count if the request briefly fails.
    }
  }, [call])

  useEffect(() => {
    load()
    loadOrderAlerts()
  }, [load, loadOrderAlerts])
  const live = useMemo(
    () =>
      session
        ? { sse: `/shop/events?token=${encodeURIComponent(session.token)}`, ticket: () => call<LiveTicket>('/shop/live', { method: 'POST' }) }
        : null,
    [session, call],
  )
  const resync = useCallback(() => {
    load()
    loadOrderAlerts()
  }, [load, loadOrderAlerts])
  useLive(live, (event) => {
    load()
    if (event.type === 'orders.changed') loadOrderAlerts()
  }, resync, 10000)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 3000)
  }

  const act = async (job: Job, action: string, body: ActBody = {}) => {
    if (action === 'ready' && needsReadyDialog(job) && body.otherPricePaise === undefined && body.pages === undefined) {
      setPricing(job)
      return
    }
    if (action === 'collected' && noReceipt[job.id]) body = { ...body, noReceipt: true }
    try {
      await call<Job>(`/shop/jobs/${job.id}/${action}`, { body })
      await load()
      if (action === 'claim') setOpenId(job.id)
      if (action === 'ready' || action === 'collected' || action === 'cancel') setOpenId(null)
      if (action === 'ready') setPricing(null)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_claimed') flash(`${job.token} was taken by another counter.`)
      else flash(e instanceof ApiError ? e.message : 'Action failed')
      await load()
    }
  }

  const markCopiesDeleted = async (job: Job) => {
    if (!window.confirm(`Confirm you deleted every downloaded copy of ${job.token}'s files from this device — Downloads folder and Recycle Bin?\n\nThe customer will see this on their receipt.`))
      return
    try {
      await call<Job>(`/shop/jobs/${job.id}/copies-deleted`, { body: {} })
      flash(`${job.token}: copies marked deleted`)
      await load()
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Could not update')
    }
  }

  const claimNext = async () => {
    try {
      const j = await call<Job>('/shop/claim-next', { body: { lane } })
      await load()
      setOpenId(j.id)
    } catch (e) {
      flash(e instanceof ApiError && e.code === 'lane_empty' ? 'Nothing waiting.' : e instanceof ApiError ? e.message : 'Could not claim')
    }
  }

  const setState = async (state: OnlineState) => {
    let message = ''
    if (state === 'paused') message = window.prompt('Message for customers (optional)', 'Very busy — back in 10 minutes') ?? ''
    try {
      setShop(await call('/shop/state', { method: 'PUT', body: { state, message } }))
      await load()
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Could not change status')
    }
  }

  const runSearch = async (q: string) => {
    setQuery(q)
    if (q.trim().length < 2) {
      setResults(null)
      return
    }
    try {
      setResults(await call<Job[]>(`/shop/lookup?q=${encodeURIComponent(q)}`))
    } catch {
      setResults([])
    }
  }

  const jobs = useMemo(() => (snap?.jobs ?? []).filter((j) => !lane || j.lane === lane || (j.state !== 'queued' && j.state !== 'claimed' ? true : false)), [snap, lane])
  const openJob = snap?.jobs.find((j) => j.id === openId) ?? snap?.copiesToDelete.find((j) => j.id === openId) ?? results?.find((j) => j.id === openId) ?? null

  // Keyboard: N claim next, R ready (open job), C collected (open job), / search, Esc close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'n' || e.key === 'N') claimNext()
      else if ((e.key === 'r' || e.key === 'R') && openJob?.state === 'claimed') act(openJob, 'ready')
      else if ((e.key === 'c' || e.key === 'C') && openJob?.state === 'ready') act(openJob, 'collected')
      else if (e.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!snap) {
    return <div className="flex min-h-screen items-center justify-center">{error ? <Banner tone="danger">{error}</Banner> : <Spinner className="h-8 w-8" />}</div>
  }
  const shop = snap.shop
  const queuedCount = (l: string) => snap.jobs.filter((j) => j.state === 'queued' && (!l || j.lane === l)).length
  const isOwner = session?.staff.role === 'owner'

  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print sticky top-0 z-20 border-b border-line bg-surface">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <Logo size={36} />
          <div className="min-w-0">
            <div className="truncate font-bold">{shop.name}</div>
            <div className="font-mono text-xs text-ink-muted">
              {session?.staff.name} · {snap.todayCount} today
            </div>
          </div>
          <div className="flex rounded border-[1.5px] border-line" role="group" aria-label="Shop status">
            {(['online', 'paused', 'offline'] as OnlineState[]).map((s) => (
              <button
                key={s}
                onClick={() => setState(s)}
                aria-pressed={shop.onlineState === s}
                className={`min-h-[40px] px-3 text-sm font-semibold capitalize ${shop.onlineState === s ? (s === 'online' ? 'bg-ready text-white' : s === 'paused' ? 'bg-attention text-white' : 'bg-ink text-canvas') : 'text-ink-muted'}`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="relative ml-auto min-w-[220px] flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => runSearch(e.target.value)}
              placeholder="Token or name   [ / ]"
              aria-label="Find a job by token or name"
              className="h-10 w-full rounded border-[1.5px] border-line bg-canvas pl-9 pr-3 font-mono text-sm"
            />
            {results && (
              <div className="absolute left-0 right-0 top-11 z-30 max-h-80 overflow-auto rounded border-[1.5px] border-line bg-surface shadow-modal">
                {results.length === 0 ? (
                  <p className="p-3 text-sm text-ink-muted">No match today.</p>
                ) : (
                  results.map((j) => (
                    <button
                      key={j.id}
                      className="flex w-full items-center gap-3 border-b border-divider px-3 py-2 text-left hover:bg-surface-tint"
                      onClick={() => {
                        setOpenId(j.id)
                        setResults(null)
                        setQuery('')
                      }}
                    >
                      <span className="font-mono text-lg font-bold">{j.token}</span>
                      <span className="flex-1 truncate">{j.customerName || '—'}</span>
                      <Chip>{j.state}</Chip>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {snap.copiesToDelete.length > 0 && (
            <button
              type="button"
              onClick={() => setCopiesOpen(true)}
              className={`flex min-h-[40px] items-center gap-2 rounded border-[1.5px] px-3 text-sm font-semibold ${snap.copiesToDelete.some((j) => j.copiesDeleteRequestedAt) ? 'border-attention bg-attention-bg text-attention' : 'border-line text-ink'}`}
            >
              <Download className="h-4 w-4" aria-hidden /> Downloaded copies <span className="font-mono">({snap.copiesToDelete.length})</span>
            </button>
          )}
          <div className="flex items-center gap-1">
            <IconBtn label={rush ? 'Rush mode on' : 'Rush mode off'} onClick={() => setRush(!rush)} active={rush}>
              <Zap className="h-5 w-5" />
            </IconBtn>
            <IconBtn
              label={sound ? 'Sound on' : 'Sound off'}
              onClick={() => {
                setSound(!sound)
                if (!sound) chime('soft')
              }}
            >
              {sound ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
            </IconBtn>
            <IconBtn label={dark ? 'Light theme' : 'Dark theme'} onClick={() => setDark(!dark)}>
              {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </IconBtn>
            <Link
              to="/shop/orders"
              aria-label={ordersNeedingPrice ? `Orders, ${ordersNeedingPrice} need a price` : 'Orders'}
              className="flex items-center gap-1.5 rounded px-2 py-2 text-sm font-semibold hover:bg-surface-tint"
              title={ordersNeedingPrice ? `${ordersNeedingPrice} orders need a price` : 'Orders — blackbooks, binding, cards…'}
            >
              <BookOpen className="h-5 w-5" aria-hidden /> <span className="hidden md:inline">Orders</span>
              <span className="sr-only md:hidden">Orders</span>
              {ordersNeedingPrice > 0 && <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-xs font-bold leading-none text-white">{ordersNeedingPrice > 99 ? '99+' : ordersNeedingPrice}</span>}
            </Link>
            <Link to="/shop/qr" className="rounded p-2 hover:bg-surface-tint" aria-label="QR poster" title="QR poster">
              <QrCode className="h-5 w-5" />
            </Link>
            {isOwner && (
              <Link to="/shop/dashboard" className="rounded p-2 hover:bg-surface-tint" aria-label="Dashboard" title="Dashboard — earnings and stats">
                <BarChart3 className="h-5 w-5" />
              </Link>
            )}
            {isOwner && (
              <Link to="/shop/settings" className="rounded p-2 hover:bg-surface-tint" aria-label="Settings" title="Settings">
                <Settings className="h-5 w-5" />
              </Link>
            )}
            <Link to="/shop/account" className="rounded p-2 hover:bg-surface-tint" aria-label="My account and PIN" title="My account and PIN">
              <UserRound className="h-5 w-5" />
            </Link>
            <IconBtn label="Sign out" onClick={logout}>
              <LogOut className="h-5 w-5" />
            </IconBtn>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-2">
          <div className="flex gap-1" role="tablist" aria-label="Lanes">
            <LaneTab active={lane === ''} onClick={() => setLane('')} label="All lanes" count={queuedCount('')} />
            {shop.lanes.map((l) => (
              <LaneTab key={l.id} active={lane === l.letter} onClick={() => setLane(l.letter)} label={`Lane ${l.letter} · ${l.name}`} count={queuedCount(l.letter)} />
            ))}
          </div>
          <Button size="sm" className="ml-auto" onClick={claimNext}>
            <Play className="h-4 w-4" aria-hidden /> Claim oldest <kbd className="rounded bg-white/20 px-1 font-mono text-xs">N</kbd>
          </Button>
          <span className="hidden font-mono text-xs text-ink-muted lg:inline">R ready · C collected · / search</span>
        </div>
        {shop.onlineState !== 'online' && <div className="bg-attention-bg px-4 py-1 text-sm font-semibold text-attention">Customers can't send new jobs while the shop is {shop.onlineState}.</div>}
        {error && <div className="bg-danger-bg px-4 py-1 text-sm font-semibold text-danger">{error}</div>}
      </header>

      <div className="flex gap-1 border-b border-line bg-surface px-2 lg:hidden" role="tablist">
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={mobileCol === c.key}
            onClick={() => setMobileCol(c.key)}
            className={`flex-1 border-b-2 px-2 py-2 text-sm font-semibold ${mobileCol === c.key ? 'border-action text-action' : 'border-transparent text-ink-muted'}`}
          >
            {c.title.split(' ·')[0]} <span className="font-mono">{jobs.filter((j) => c.states.includes(j.state)).length}</span>
          </button>
        ))}
      </div>

      <main className="grid flex-1 gap-3 p-3 lg:grid-cols-4">
        {COLUMNS.map((c) => {
          let list = jobs.filter((j) => c.states.includes(j.state))
          if (c.key === 'collected') list = list.slice().reverse()
          if (rush && c.key === 'queued') list = list.slice(0, 3)
          return (
            <section key={c.key} className={`${mobileCol === c.key ? 'block' : 'hidden'} min-w-0 lg:block`} aria-label={c.title}>
              <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-bold uppercase tracking-wide text-ink-muted">
                {c.title}
                <span className="font-mono">{list.length}</span>
              </h2>
              <div className="space-y-2">
                {list.length === 0 && <p className="rounded border border-dashed border-line p-4 text-center text-sm text-ink-subtle">Nothing here</p>}
                {list.map((j) => (
                  <JobCard
                    key={j.id}
                    job={j}
                    now={now}
                    rush={rush}
                    undoSeconds={snap.undoWindowSeconds}
                    onOpen={() => setOpenId(j.id)}
                    act={act}
                    markCopiesDeleted={markCopiesDeleted}
                    receipt={!noReceipt[j.id]}
                    toggleReceipt={() => setNoReceipt((m) => ({ ...m, [j.id]: !m[j.id] }))}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </main>

      {openJob && (
        <JobPanel
          job={openJob}
          onClose={() => setOpenId(null)}
          act={act}
          call={call}
          flash={flash}
          reload={load}
          markCopiesDeleted={markCopiesDeleted}
          receipt={!noReceipt[openJob.id]}
          toggleReceipt={() => setNoReceipt((m) => ({ ...m, [openJob.id]: !m[openJob.id] }))}
        />
      )}
      {pricing && <ReadyDialog job={pricing} prices={snap.shop.prices} onCancel={() => setPricing(null)} onConfirm={(body) => act(pricing, 'ready', body)} />}
      {copiesOpen && snap.copiesToDelete.length > 0 && (
        <CopiesDrawer
          jobs={snap.copiesToDelete}
          onClose={() => setCopiesOpen(false)}
          onOpen={(id) => {
            setCopiesOpen(false)
            setOpenId(id)
          }}
          markCopiesDeleted={markCopiesDeleted}
        />
      )}
      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded border-2 border-ink bg-surface px-4 py-2 font-semibold shadow-modal">
          {toast}
        </div>
      )}
    </div>
  )
}

function IconBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`rounded p-2 hover:bg-surface-tint ${active ? 'bg-attention-bg text-attention' : ''}`}>
      {children}
    </button>
  )
}

function LaneTab({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`min-h-[36px] rounded px-3 text-sm font-semibold ${active ? 'bg-ink text-canvas' : 'border-[1.5px] border-line text-ink-muted'}`}
    >
      {label} <span className="font-mono">({count})</span>
    </button>
  )
}

const downloaded = (j: Job) => j.files.some((f) => f.downloads > 0)

function JobCard({
  job,
  now,
  rush,
  undoSeconds,
  onOpen,
  act,
  markCopiesDeleted,
  receipt,
  toggleReceipt,
}: {
  job: Job
  now: number
  rush: boolean
  undoSeconds: number
  onOpen: () => void
  act: (j: Job, a: string, b?: ActBody) => void
  markCopiesDeleted: (j: Job) => void
  receipt: boolean
  toggleReceipt: () => void
}) {
  const age = minutesSince(job.queuedAt, now)
  const ageTone = job.state === 'queued' ? (age >= 20 ? 'danger' : age >= 10 ? 'attention' : 'neutral') : 'neutral'
  const undoLeft = job.collectedAt ? new Date(job.collectedAt).getTime() + undoSeconds * 1000 - now : 0
  return (
    <article className={`rounded border-[1.5px] bg-surface p-3 ${job.state === 'ready' ? 'border-ready' : job.state === 'claimed' ? 'border-action' : 'border-line'}`}>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 text-left" aria-label={`Open ${job.token}`}>
        <span className={`font-mono font-bold leading-none ${rush ? 'text-4xl' : 'text-3xl'}`}>{job.token ?? '—'}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{job.customerName || 'Walk-in'}</span>
          {!rush && (
            <span className="block text-xs text-ink-muted">
              {job.files.length} file{job.files.length === 1 ? '' : 's'} · {job.pagesToConfirm ? 'pages ?' : `${job.pagesTotal} pp`} · {settingsSummary(job)}
            </span>
          )}
        </span>
        <span className="text-right">
          <span className="block font-mono font-bold">{priceLabel(job)}</span>
          {job.state === 'queued' && <Chip tone={ageTone}>{age} min</Chip>}
          {job.state === 'claimed' && job.claimedBy && <span className="block text-xs text-ink-muted">{job.claimedBy}</span>}
        </span>
      </button>
      <div className="mt-2 flex flex-wrap gap-2">
        {job.lane && <Chip>Lane {job.lane}</Chip>}
        <Chip tone="dark">WALK-IN</Chip>
        {otherFiles(job).length > 0 && (
          <Chip tone="action">
            <FilePlus2 className="h-3 w-3" aria-hidden /> OTHER ×{otherFiles(job).length}
          </Chip>
        )}
        {job.state === 'collected' && job.noReceipt && <Chip>No receipt</Chip>}
        {downloaded(job) && (
          <Chip tone={job.copiesDeletedAt ? 'ready' : 'attention'}>
            <Download className="h-3 w-3" aria-hidden /> {job.copiesDeletedAt ? 'Copy deleted' : 'Downloaded'}
          </Chip>
        )}
        {job.copiesDeleteRequestedAt && !job.copiesDeletedAt && <Chip tone="danger">Customer asked to delete</Chip>}
      </div>
      <div className="mt-3 flex gap-2">
        {job.state === 'queued' && (
          <Button size={rush ? 'lg' : 'md'} className="flex-1" onClick={() => act(job, 'claim')}>
            <Printer className="h-4 w-4" aria-hidden /> Claim
          </Button>
        )}
        {job.state === 'claimed' && (
          <>
            <Button size="md" variant="secondary" onClick={onOpen}>
              <ExternalLink className="h-4 w-4" aria-hidden /> Files
            </Button>
            <Button size={rush ? 'lg' : 'md'} variant="ready" className="flex-1" onClick={() => act(job, 'ready')}>
              <Check className="h-4 w-4" aria-hidden /> Ready
            </Button>
          </>
        )}
        {job.state === 'ready' && (
          <>
            <ReceiptToggle on={receipt} toggle={toggleReceipt} compact />
            <Button size="md" variant="secondary" className="flex-1" onClick={() => act(job, 'collected', { paid: 'cash' })}>
              Paid cash
            </Button>
            <Button size="md" variant="secondary" className="flex-1" onClick={() => act(job, 'collected', { paid: 'upi' })}>
              Paid UPI
            </Button>
            <Button size="md" variant="ready" onClick={() => act(job, 'collected')} aria-label="Collected">
              <Check className="h-4 w-4" aria-hidden />
            </Button>
          </>
        )}
        {job.state === 'collected' && (
          <>
            <span className="flex-1 self-center text-xs text-ink-muted">
              {job.filesDeletedAt ? `Files deleted ${clock(job.filesDeletedAt)}` : `Files deleted in ${mmss(undoLeft)}`}
              {job.paidMethod ? ` · paid ${job.paidMethod === 'upi' ? 'UPI' : job.paidMethod}` : ''}
            </span>
            {!job.filesDeletedAt && undoLeft > 0 && (
              <Button size="sm" variant="secondary" onClick={() => act(job, 'undo')}>
                <Undo2 className="h-4 w-4" aria-hidden /> Undo
              </Button>
            )}
            {downloaded(job) && !job.copiesDeletedAt && (
              <Button size="sm" variant="secondary" onClick={() => markCopiesDeleted(job)}>
                <FileCheck2 className="h-4 w-4" aria-hidden /> Copies deleted
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  )
}

function JobPanel({
  job,
  onClose,
  act,
  call,
  flash,
  reload,
  markCopiesDeleted,
  receipt,
  toggleReceipt,
}: {
  job: Job
  onClose: () => void
  receipt: boolean
  toggleReceipt: () => void
  act: (j: Job, a: string, b?: ActBody) => Promise<void>
  call: <T>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>
  flash: (m: string) => void
  reload: () => Promise<void>
  markCopiesDeleted: (j: Job) => void
}) {
  const [reason, setReason] = useState('')
  // Print: open in a new tab and print from the browser (nothing is saved on this computer).
  const printFile = async (fileId: string) => {
    // Open the tab synchronously so pop-up blockers allow it, then point it at the signed URL.
    const w = window.open('', '_blank')
    try {
      const { url } = await call<{ url: string }>(`/shop/jobs/${job.id}/files/${fileId}/url?mode=print`)
      if (w) w.location.href = url
      else window.location.href = url
      reload()
    } catch (e) {
      w?.close()
      flash(e instanceof ApiError ? e.message : 'Could not open file')
    }
  }
  // Download: saves the file on this computer. The customer is told, and the shop must delete it later.
  const downloadFile = async (fileId: string, name: string, needsApp = false) => {
    const why = needsApp ? `"${name}" can't open in the browser — download it and print from Word, Excel or your photo app.` : `Download "${name}" to this computer?`
    if (!window.confirm(`${why}\n\nThe customer will be told you downloaded it. Delete it after the job and tap "Copies deleted".`)) return
    try {
      const { url } = await call<{ url: string }>(`/shop/jobs/${job.id}/files/${fileId}/url?mode=download`)
      const a = document.createElement('a')
      a.href = url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      reload()
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Could not download file')
    }
  }
  const finished = job.state === 'collected' || job.state === 'cancelled'
  return (
    <div className="no-print fixed inset-0 z-40 flex justify-end bg-[rgba(15,23,42,0.72)]" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col overflow-auto border-l-2 border-ink bg-surface" onClick={(e) => e.stopPropagation()} aria-label={`Job ${job.token}`}>
        <div className="flex items-center gap-3 border-b border-line p-4">
          <span className="font-mono text-4xl font-bold">{job.token}</span>
          <div className="flex-1">
            <div className="font-semibold">{job.customerName || 'Walk-in'}</div>
            <div className="text-xs capitalize text-ink-muted">
              {job.state === 'claimed' ? `Printing · ${job.claimedBy}` : job.state} · queued {clock(job.queuedAt)}
            </div>
          </div>
          <button onClick={onClose} className="rounded p-2 hover:bg-surface-tint" aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
        <div className="flex-1 space-y-2 p-4">
          {job.files.map((f, i) => (
            <div key={f.id} className="rounded border-[1.5px] border-line p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-ink-muted">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{f.filename || 'Deleted file'}</span>
                {!f.deletedAt && job.state !== 'cancelled' && (
                  <>
                    {browserPrintable(f.mime) ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => printFile(f.id)}>
                          <ExternalLink className="h-4 w-4" aria-hidden /> Print
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => downloadFile(f.id, f.filename)} aria-label={`Download ${f.filename}`} title="Download (customer is told)">
                          <Download className="h-4 w-4" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => downloadFile(f.id, f.filename, true)} title="Opens in Word/Excel on this computer (customer is told)">
                        <Download className="h-4 w-4" aria-hidden /> Download to print
                      </Button>
                    )}
                  </>
                )}
              </div>
              {(f.printOpens > 0 || f.downloads > 0) && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {f.printOpens > 0 && <Chip>Opened to print ×{f.printOpens}</Chip>}
                  {f.downloads > 0 && (
                    <Chip tone="attention">
                      <Download className="h-3 w-3" aria-hidden /> Downloaded by {f.downloadedBy} · {clock(f.downloadedAt)}
                    </Chip>
                  )}
                </div>
              )}
              {f.settings.other ? (
                <div className="mt-1 rounded bg-surface-tint p-2 text-sm">
                  <span className="font-bold">OTHER — you set the price</span>
                  {f.settings.note ? <span className="mt-0.5 block">“{f.settings.note}”</span> : <span className="mt-0.5 block text-ink-muted">No note — ask the customer</span>}
                </div>
              ) : (
                <div className="mt-1 text-sm font-bold">
                  {f.pages <= 0 ? 'Pages: count when printing' : `${f.pages} page${f.pages === 1 ? '' : 's'}${f.pagesStatus === 'confirmed' ? ' (you counted)' : ''}`}
                  {f.settings.pageRange ? ` · print pages ${f.settings.pageRange}` : ''} · {f.settings.colour ? 'COLOUR' : 'B/W'} · {f.settings.bothSides ? 'BOTH SIDES' : 'ONE SIDE'} · ×
                  {f.settings.copies}
                </div>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between rounded bg-surface-tint p-3">
            <span className="font-semibold">Collect at counter</span>
            <span className="font-mono text-xl font-bold">{job.pagesToConfirm ? 'Confirm pages' : priceLabel(job)}</span>
          </div>
          {job.otherPricePaise !== undefined && (
            <p className="px-1 text-xs text-ink-muted">Includes {rupees(job.otherPricePaise)} you set for Other files.</p>
          )}
          {needsOtherPrice(job) && <p className="px-1 text-xs text-ink-muted">You'll enter the price for Other files when you mark it ready.</p>}
          {job.pagesToConfirm && <p className="px-1 text-xs text-ink-muted">Count the pages when you open the file — you'll enter them when you mark it ready, and the price is worked out from your price list.</p>}
        </div>
        <div className="space-y-2 border-t border-line p-4">
          {job.state === 'queued' && (
            <Button className="w-full" size="lg" onClick={() => act(job, 'claim')}>
              <Printer className="h-5 w-5" aria-hidden /> Claim
            </Button>
          )}
          {job.state === 'claimed' && (
            <>
              <Button variant="ready" className="w-full" size="lg" onClick={() => act(job, 'ready')}>
                <Check className="h-5 w-5" aria-hidden /> Mark ready <kbd className="rounded bg-white/20 px-1 font-mono text-xs">R</kbd>
              </Button>
              <Button variant="secondary" className="w-full" onClick={() => act(job, 'release')}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Release to top of line
              </Button>
            </>
          )}
          {job.state === 'ready' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <ReceiptToggle on={receipt} toggle={toggleReceipt} />
              </div>
              <Button variant="secondary" onClick={() => act(job, 'collected', { paid: 'cash' })}>
                Paid cash
              </Button>
              <Button variant="secondary" onClick={() => act(job, 'collected', { paid: 'upi' })}>
                Paid UPI
              </Button>
              <Button variant="ready" className="col-span-2" size="lg" onClick={() => act(job, 'collected')}>
                <Check className="h-5 w-5" aria-hidden /> Collected <kbd className="rounded bg-white/20 px-1 font-mono text-xs">C</kbd>
              </Button>
            </div>
          )}
          {finished && downloaded(job) && (
            <div className={`rounded p-3 text-sm ${job.copiesDeletedAt ? 'bg-ready-bg text-ready' : 'bg-attention-bg text-attention'}`}>
              {job.copiesDeletedAt ? (
                <p className="font-semibold">
                  Downloaded copies deleted · {job.copiesDeletedBy} · {dayTime(job.copiesDeletedAt)}
                </p>
              ) : (
                <>
                  <p className="font-semibold">
                    {job.copiesDeleteRequestedAt ? `The customer asked you to delete the downloaded copies (${dayTime(job.copiesDeleteRequestedAt)}).` : 'This job was downloaded to a computer here.'}
                  </p>
                  <p className="mt-1 text-ink">Delete the files from the Downloads folder and Recycle Bin, then confirm.</p>
                  <Button className="mt-2 w-full" variant="ready" onClick={() => markCopiesDeleted(job)}>
                    <FileCheck2 className="h-5 w-5" aria-hidden /> Copies deleted
                  </Button>
                </>
              )}
            </div>
          )}
          {(job.state === 'queued' || job.state === 'claimed' || job.state === 'ready') && (
            <div className="flex gap-2 pt-2">
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="h-12 flex-1 rounded border-[1.5px] border-line bg-surface px-2 text-sm" aria-label="Cancel reason">
                <option value="">Cancel job — choose a reason</option>
                {CANCEL_REASONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <Button variant="danger" disabled={!reason} onClick={() => window.confirm(`Cancel ${job.token}? The customer's files will be deleted.`) && act(job, 'cancel', { reason })}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function CopiesDrawer({ jobs, onClose, onOpen, markCopiesDeleted }: { jobs: Job[]; onClose: () => void; onOpen: (id: string) => void; markCopiesDeleted: (j: Job) => void }) {
  return (
    <div className="no-print fixed inset-0 z-40 flex justify-end bg-[rgba(15,23,42,0.72)]" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col overflow-auto border-l-2 border-ink bg-surface" onClick={(e) => e.stopPropagation()} aria-label="Downloaded copies">
        <div className="flex items-center gap-3 border-b border-line p-4">
          <Download className="h-6 w-6" aria-hidden />
          <div className="flex-1">
            <h2 className="text-lg font-bold">Downloaded copies to delete</h2>
            <p className="text-xs text-ink-muted">Finished jobs that were downloaded here. Delete the files, then confirm — customers see it on their receipt.</p>
          </div>
          <button onClick={onClose} className="rounded p-2 hover:bg-surface-tint" aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
        <ul className="flex-1 divide-y divide-divider">
          {jobs.length === 0 && <li className="p-4 text-sm text-ink-muted">Nothing to delete.</li>}
          {jobs.map((j) => (
            <li key={j.id} className="space-y-2 p-4">
              <div className="flex items-center gap-3">
                <button className="font-mono text-2xl font-bold underline-offset-4 hover:underline" onClick={() => onOpen(j.id)}>
                  {j.token}
                </button>
                <span className="flex-1 text-xs text-ink-muted">
                  {j.state === 'collected' ? 'Collected' : 'Cancelled'} {dayTime(j.collectedAt || j.cancelledAt)}
                </span>
                {j.copiesDeleteRequestedAt && <Chip tone="danger">Customer asked</Chip>}
              </div>
              <ul className="text-sm text-ink-muted">
                {j.files
                  .filter((f) => f.downloads > 0)
                  .map((f, i) => (
                    <li key={f.id}>
                      {f.filename || `File ${i + 1}`} · downloaded by {f.downloadedBy} {clock(f.downloadedAt)}
                    </li>
                  ))}
              </ul>
              <Button size="sm" variant="ready" onClick={() => markCopiesDeleted(j)}>
                <FileCheck2 className="h-4 w-4" aria-hidden /> Copies deleted
              </Button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  )
}

/** Before marking ready: page counts for documents the phone couldn't count, and the price for Other files. */
function ReadyDialog({ job, prices, onCancel, onConfirm }: { job: Job; prices: PriceList; onCancel: () => void; onConfirm: (body: ActBody) => void }) {
  const docs = job.pagesToConfirm ? pagesNeeded(job) : []
  const askPrice = needsOtherPrice(job)
  const [pages, setPages] = useState<Record<string, string>>({})
  const [value, setValue] = useState('')
  const counts: Record<string, number> = {}
  for (const f of docs) counts[f.id] = Number(pages[f.id] || 0)
  const pagesValid = docs.every((f) => {
    const n = counts[f.id] ?? 0
    return Number.isInteger(n) && n >= 1 && n <= 2000
  })
  const rupeesIn = Number(value)
  const priceValid = !askPrice || (value.trim() !== '' && Number.isFinite(rupeesIn) && rupeesIn >= 0 && rupeesIn <= 50000)
  const paise = askPrice && priceValid ? Math.round(rupeesIn * 100) : 0
  const valid = pagesValid && priceValid
  const printed = docs.length > 0 ? (pagesValid ? estimatePaise(prices, job.files, counts) : null) : job.priceTotalPaise - (job.otherPricePaise ?? 0)
  const items = otherFiles(job)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.72)] p-4" onClick={onCancel}>
      <form
        role="dialog"
        aria-label={`Mark ${job.token} ready`}
        className="max-h-full w-full max-w-sm space-y-3 overflow-auto rounded border-2 border-ink bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          const body: ActBody = {}
          if (docs.length) body.pages = counts
          if (askPrice) body.otherPricePaise = paise
          onConfirm(body)
        }}
      >
        <h2 className="text-lg font-bold">
          <span className="font-mono">{job.token}</span> · {docs.length ? 'pages' : 'price'}
          {docs.length && askPrice ? ' & price' : ''}
        </h2>
        {docs.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm text-ink-muted">How many pages does each file have? (whole document, before copies)</legend>
            {docs.map((f, i) => (
              <label key={f.id} className="flex items-center gap-2 rounded bg-surface-tint p-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{f.filename}</span>
                  <span className="block text-xs text-ink-muted">
                    {f.settings.colour ? 'Colour' : 'B/W'} · {f.settings.bothSides ? 'both sides' : 'one side'} · ×{f.settings.copies}
                  </span>
                </span>
                <input
                  autoFocus={i === 0}
                  inputMode="numeric"
                  value={pages[f.id] ?? ''}
                  onChange={(e) => setPages((p) => ({ ...p, [f.id]: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) }))}
                  className="h-11 w-20 rounded border-[1.5px] border-line bg-surface px-2 text-right font-mono text-lg"
                  placeholder="0"
                  aria-label={`Pages in ${f.filename}`}
                />
              </label>
            ))}
          </fieldset>
        )}
        {askPrice && (
          <>
            <ul className="space-y-1 text-sm">
              {items.map((f) => (
                <li key={f.id} className="rounded bg-surface-tint p-2">
                  <span className="block truncate font-semibold">{f.filename}</span>
                  {f.settings.note && <span className="block">“{f.settings.note}”</span>}
                </li>
              ))}
            </ul>
            <label className="block text-sm font-semibold">
              Your price for Other files (₹)
              <input
                autoFocus={docs.length === 0}
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
                className="mt-1 h-12 w-full rounded border-[1.5px] border-line bg-surface px-3 font-mono text-xl"
                placeholder="0"
                aria-label="Price in rupees"
              />
            </label>
          </>
        )}
        <div className="flex justify-between rounded bg-surface-tint p-3 text-sm">
          <span>Total for the customer</span>
          <span className="font-mono text-lg font-bold">{printed === null ? '₹ ?' : rupees(printed + paise)}</span>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            Back
          </Button>
          <Button type="submit" variant="ready" className="flex-1" disabled={!valid}>
            <Check className="h-4 w-4" aria-hidden /> Mark ready
          </Button>
        </div>
      </form>
    </div>
  )
}

/** "Give receipt" — on by default; the shop can switch it off for a job before collecting. */
function ReceiptToggle({ on, toggle, compact }: { on: boolean; toggle: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      title={on ? 'Customer gets a receipt (tap to turn off)' : 'No receipt for this job (tap to turn on)'}
      className={`flex items-center justify-center gap-2 rounded border-[1.5px] px-3 text-sm font-semibold ${compact ? 'min-h-[48px]' : 'min-h-[44px] w-full'} ${on ? 'border-ready bg-ready-bg text-ready' : 'border-line text-ink-muted line-through'}`}
    >
      <ReceiptText className="h-4 w-4" aria-hidden /> {compact ? '' : on ? 'Give receipt' : 'No receipt'}
      {compact && <span className="sr-only">{on ? 'Give receipt' : 'No receipt'}</span>}
    </button>
  )
}
