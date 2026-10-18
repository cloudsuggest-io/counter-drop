import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Link2,
  Moon,
  Pencil,
  Phone,
  Plus,
  Printer,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useLive, type LiveTicket } from '@/lib/live'
import { clock, rupees } from '@/lib/format'
import { addDays, BINDING_LABEL, balanceOf, dateLabel, daysUntil, dueLabel, STATE_LABEL, todayIST } from '@/lib/orders'
import type { Binding, CoverText, Order, OrderLine, OrderSettings, OrderSpec, OrderState, OrdersSnapshot, ShopOrderView } from '@/lib/types'
import { proofLocked, serviceOf, SERVICES, UNIT_EN, type ServiceDef } from '@/lib/services'
import { ServiceIcon } from '@/components/ServiceIcon'
import { Banner, Button, Chip, Spinner, Stepper } from '@/components/ui'
import { useShopAuth, useShopTheme } from './auth'

// Shop screen for multi-day orders (blackbooks, binding, cards, banners…): quote, advance, stages,
// delivery. English only.

const input = 'mt-1 h-11 w-full rounded border-[1.5px] border-line bg-surface px-3 text-base focus:border-action focus:outline-none'
// Same look without width/margin, for inputs sized by their row (quote lines, advance).
const rowInput = 'h-11 rounded border-[1.5px] border-line bg-surface px-3 text-base focus:border-action focus:outline-none'
const toRs = (p: number) => (p ? String(p / 100) : '')
const toPaise = (v: string) => Math.round((Number(v.trim() || '0') || 0) * 100)

const COVER_FIELDS: { k: keyof CoverText; label: string; wide?: boolean }[] = [
  { k: 'title', label: 'Project title', wide: true },
  { k: 'student', label: 'Student name(s)' },
  { k: 'rollNo', label: 'Roll / seat no.' },
  { k: 'course', label: 'Course' },
  { k: 'year', label: 'Academic year' },
  { k: 'college', label: 'College', wide: true },
  { k: 'guide', label: 'Guide' },
  { k: 'spine', label: 'Spine text' },
  { k: 'extra', label: 'Other cover text', wide: true },
]

const STAGE_RANK: Partial<Record<OrderState, number>> = { confirmed: 0, printing: 1, binding: 2, ready: 3 }

/** One line saying what to make, for cards and slips. */
function summary(o: Order): string {
  const svc = serviceOf(o.kind)
  if (svc.form === 'document') {
    return [`${o.spec.copies ?? 1} × ${BINDING_LABEL[o.spec.binding ?? 'none']}`, o.spec.pages ? `${o.spec.pages} pp` : ''].filter(Boolean).join(' · ')
  }
  if (svc.form === 'quantity') return [`${o.spec.quantity ?? 0} ${svc.unit ? UNIT_EN[svc.unit] : ''}`, o.spec.size ?? ''].filter(Boolean).join(' · ')
  return o.spec.description ?? ''
}

/** The proof still waits for the customer's OK (and blocks a later stage). */
function proofPending(o: Order): boolean {
  return !!serviceOf(o.kind).proof && o.state !== 'delivered' && o.state !== 'cancelled' && !o.coverApprovedAt
}

function proofName(svc: ServiceDef): string {
  return svc.proof === 'text' ? 'Text to print' : 'Cover text'
}

function stateTone(s: OrderState): 'neutral' | 'ready' | 'attention' | 'danger' | 'action' {
  if (s === 'requested' || s === 'quoted') return 'attention'
  if (s === 'ready' || s === 'delivered') return 'ready'
  if (s === 'cancelled') return 'danger'
  if (s === 'printing' || s === 'binding') return 'action'
  return 'neutral'
}

function DueChip({ o }: { o: Order }) {
  const d = daysUntil(o.dueDate)
  if (o.state === 'delivered' || o.state === 'cancelled') return <span className="text-xs text-ink-muted">{dueLabel(o.dueDate)}</span>
  if (o.state !== 'ready' && d < 0) return <Chip tone="danger">Late · {dueLabel(o.dueDate)}</Chip>
  if (d === 0) return <Chip tone="attention">Due today</Chip>
  if (d === 1) return <Chip>Due tomorrow</Chip>
  return <Chip>Due {dueLabel(o.dueDate)}</Chip>
}

export default function OrdersPage() {
  const { session, call } = useShopAuth()
  const [dark, setDark] = useShopTheme()
  const [snap, setSnap] = useState<OrdersSnapshot | null>(null)
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [fresh, setFresh] = useState<ShopOrderView | null>(null) // just created: show the customer link
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0) // bumps on live updates so an open order panel refreshes too

  const load = useCallback(async () => {
    try {
      setSnap(await call<OrdersSnapshot>('/shop/orders'))
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Connection problem — showing the last list.')
    }
  }, [call])
  useEffect(() => {
    load()
  }, [load])
  const live = useMemo(
    () => (session ? { sse: `/shop/events?token=${encodeURIComponent(session.token)}`, ticket: () => call<LiveTicket>('/shop/live', { method: 'POST' }) } : null),
    [session, call],
  )
  useLive(
    live,
    (e) => {
      if (e.type !== 'orders.changed') return
      load()
      setTick((n) => n + 1)
    },
    load,
    30000,
  )

  if (!snap) {
    return <div className="flex min-h-screen items-center justify-center">{error ? <Banner tone="danger">{error}</Banner> : <Spinner className="h-8 w-8" />}</div>
  }

  const today = todayIST()
  const needPrice = snap.open.filter((o) => o.state === 'requested')
  const waiting = snap.open.filter((o) => o.state === 'quoted')
  const working = snap.open.filter((o) => o.state === 'confirmed' || o.state === 'printing' || o.state === 'binding')
  const ready = snap.open.filter((o) => o.state === 'ready')
  const dueToday = snap.open.filter((o) => o.state !== 'ready' && o.dueDate === today).length
  const late = snap.open.filter((o) => o.state !== 'ready' && o.dueDate < today).length
  const toCollect = snap.open.filter((o) => o.state !== 'requested').reduce((s, o) => s + balanceOf(o), 0)

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b-[1.5px] border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/shop" className="rounded p-2 hover:bg-surface-tint" aria-label="Back to board" title="Back to board">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BookOpen className="h-5 w-5 text-action" aria-hidden />
            <h1 className="text-lg font-bold">Orders</h1>
          </div>
          <button type="button" onClick={() => setDark(!dark)} className="rounded p-2 hover:bg-surface-tint" aria-label={dark ? 'Light theme' : 'Dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-5 w-5" aria-hidden /> New order
          </Button>
        </div>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 pb-3">
          <Stat label="Need price" value={needPrice.length} tone={needPrice.length ? 'attention' : undefined} />
          <Stat label="Due today" value={dueToday} tone={dueToday ? 'attention' : undefined} />
          <Stat label="Late" value={late} tone={late ? 'danger' : undefined} />
          <Stat label="Ready" value={ready.length} tone={ready.length ? 'ready' : undefined} />
          <Stat label="To collect" value={rupees(toCollect)} />
          <div className="ml-auto flex overflow-hidden rounded border-[1.5px] border-line" role="tablist">
            {(['open', 'done'] as const).map((k, i) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`min-h-[40px] px-4 text-sm font-semibold ${i ? 'border-l-[1.5px] border-line' : ''} ${tab === k ? 'bg-action text-white' : 'text-ink-muted'}`}
              >
                {k === 'open' ? `Open (${snap.open.length})` : 'Delivered & cancelled'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 p-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {!snap.settings.enabled && (
          <Banner tone="attention">Customers can’t send orders online — the owner can turn it on in Settings. You can still take orders here.</Banner>
        )}
        {tab === 'open' ? (
          snap.open.length === 0 ? (
            <Empty onNew={() => setCreating(true)} />
          ) : (
            <>
              <Group title="Needs price" hint="Send the price so the customer can pay the advance." list={needPrice} onOpen={setOpenId} />
              <Group title="Waiting for advance" list={waiting} onOpen={setOpenId} />
              <Group title="In progress" list={working} onOpen={setOpenId} />
              <Group title="Ready for pickup" list={ready} onOpen={setOpenId} />
            </>
          )
        ) : (
          <Group title="Last 30 days" list={snap.recent} onOpen={setOpenId} emptyText="Nothing delivered or cancelled in the last 30 days." />
        )}
      </main>

      {openId && <OrderPanel id={openId} tick={tick} onClose={() => setOpenId(null)} onChange={load} />}
      {creating && (
        <NewOrder
          settings={snap.settings}
          onClose={() => setCreating(false)}
          onCreated={(v) => {
            setCreating(false)
            setFresh(v)
            setOpenId(v.order.id)
            load()
          }}
        />
      )}
      {fresh?.secret && <LinkDialog view={fresh} secret={fresh.secret} onClose={() => setFresh(null)} />}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'attention' | 'danger' | 'ready' }) {
  const c = tone === 'danger' ? 'border-danger text-danger' : tone === 'attention' ? 'border-attention text-attention' : tone === 'ready' ? 'border-ready text-ready' : 'border-line'
  return (
    <span className={`inline-flex items-baseline gap-2 rounded border-[1.5px] px-3 py-1.5 text-sm ${c}`}>
      <b className="font-mono text-base">{value}</b>
      <span className="text-ink-muted">{label}</span>
    </span>
  )
}

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded border-[1.5px] border-dashed border-line p-10 text-center">
      <BookOpen className="mx-auto mb-3 h-10 w-10 text-ink-muted" aria-hidden />
      <p className="font-semibold">No open orders</p>
      <p className="mt-1 text-sm text-ink-muted">Students can order from your QR page, or take one at the counter.</p>
      <Button className="mt-4" onClick={onNew}>
        <Plus className="h-5 w-5" aria-hidden /> New order
      </Button>
    </div>
  )
}

function Group({ title, hint, list, onOpen, emptyText }: { title: string; hint?: string; list: Order[]; onOpen: (id: string) => void; emptyText?: string }) {
  if (list.length === 0 && !emptyText) return null
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          {title} <span className="font-mono">({list.length})</span>
        </h2>
        {hint && <span className="text-xs text-ink-muted">{hint}</span>}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-ink-muted">{emptyText}</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {list.map((o) => (
            <OrderCard key={o.id} o={o} onOpen={() => onOpen(o.id)} />
          ))}
        </div>
      )}
    </section>
  )
}

function OrderCard({ o, onOpen }: { o: Order; onOpen: () => void }) {
  const bal = balanceOf(o)
  const svc = serviceOf(o.kind)
  const needsCover = proofPending(o)
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-2 rounded border-[1.5px] border-line bg-surface p-3 text-left hover:border-action">
      <div className="flex items-center gap-2">
        <span className="font-mono text-lg font-bold">{o.code}</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{o.customerName || '—'}</span>
        <Chip tone={stateTone(o.state)}>{STATE_LABEL[o.state]}</Chip>
      </div>
      <div className="flex items-center gap-1.5 truncate text-sm text-ink-muted">
        <ServiceIcon id={o.kind} className="h-4 w-4 shrink-0" />
        <span className="truncate">{o.cover.title || o.cover.text?.split('\n')[0] || svc.name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Chip>{svc.name}</Chip>
        {summary(o) && <Chip>{summary(o)}</Chip>}
        <DueChip o={o} />
        {needsCover && <Chip tone="attention">{svc.proof === 'text' ? 'Text not approved' : 'Cover not approved'}</Chip>}
      </div>
      <div className="flex items-baseline justify-between border-t border-divider pt-2 text-sm">
        <span className="text-ink-muted">{o.totalPaise ? `Total ${rupees(o.totalPaise)}` : 'Price not sent'}</span>
        {o.totalPaise > 0 && <span className={`font-mono font-bold ${bal > 0 ? '' : 'text-ready'}`}>{bal > 0 ? `${rupees(bal)} due` : 'Paid'}</span>}
      </div>
    </button>
  )
}

// --- Order panel --------------------------------------------------------------------------------

type Mode = null | 'quote' | 'pay' | 'deliver' | 'cancel' | 'cover' | 'details'

function OrderPanel({ id, tick, onClose, onChange }: { id: string; tick: number; onClose: () => void; onChange: () => void }) {
  const { call } = useShopAuth()
  const [v, setV] = useState<ShopOrderView | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState<string | null>(null)

  const load = useCallback(() => {
    call<ShopOrderView>(`/shop/orders/${id}`)
      .then(setV)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load'))
  }, [call, id])
  useEffect(load, [load, tick])

  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setError('')
    try {
      const nv = await call<ShopOrderView>(`/shop/orders/${id}/${action}`, { body })
      setV(nv)
      setMode(null)
      if (nv.secret) setLink(nv.secret)
      onChange()
      return true
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  const download = async (fileId: string, name: string) => {
    if (!window.confirm(`Download "${name}" to this computer?\n\nThe customer will see that you downloaded it. Delete it after the order and tap "Copies deleted".`)) return
    try {
      const { url } = await call<{ url: string }>(`/shop/orders/${id}/files/${fileId}/url`)
      const a = document.createElement('a')
      a.href = url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      load()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not download')
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[rgba(15,23,42,0.72)]" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col overflow-auto border-l-2 border-ink bg-surface" onClick={(e) => e.stopPropagation()} aria-label="Order">
        {!v ? (
          <div className="flex flex-1 items-center justify-center">{error ? <Banner tone="danger">{error}</Banner> : <Spinner className="h-8 w-8" />}</div>
        ) : (
          <PanelBody v={v} mode={mode} setMode={setMode} busy={busy} error={error} act={act} download={download} onClose={onClose} />
        )}
      </aside>
      {link && v && <LinkDialog view={v} secret={link} onClose={() => setLink(null)} />}
    </div>
  )
}

function PanelBody({
  v,
  mode,
  setMode,
  busy,
  error,
  act,
  download,
  onClose,
}: {
  v: ShopOrderView
  mode: Mode
  setMode: (m: Mode) => void
  busy: boolean
  error: string
  act: (action: string, body?: Record<string, unknown>) => Promise<boolean>
  download: (fileId: string, name: string) => void
  onClose: () => void
}) {
  const o = v.order
  const open = o.state !== 'delivered' && o.state !== 'cancelled'
  const bal = v.balancePaise
  const coverOk = !!o.coverApprovedAt
  const svc = serviceOf(o.kind)
  const binds = svc.form === 'document' && !!o.spec.binding && o.spec.binding !== 'none'
  const next: Partial<Record<OrderState, { to: OrderState; label: string }>> = {
    confirmed: { to: 'printing', label: svc.form === 'document' ? 'Start printing' : 'Start work' },
    printing: binds ? { to: 'binding', label: 'Sent for binding' } : { to: 'ready', label: 'Mark ready' },
    binding: { to: 'ready', label: 'Mark ready' },
  }
  const step = next[o.state]
  // Work can't pass the proof stage until the customer approved it (the API checks this too).
  const blocked = (to: OrderState) => !!svc.proof && !coverOk && (STAGE_RANK[to] ?? 0) >= (STAGE_RANK[svc.proofBefore ?? 'ready'] ?? 99)
  const canEditProof = open && o.state !== 'ready' && !proofLocked(svc, o.state)
  const downloaded = o.files.some((f) => f.downloads > 0)

  return (
    <>
      <div className="flex items-start gap-3 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-3xl font-bold">{o.code}</span>
            <Chip tone={stateTone(o.state)}>{STATE_LABEL[o.state]}</Chip>
            <DueChip o={o} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm">
            <span className="font-semibold">{o.customerName || '—'}</span>
            {o.phone && (
              <a href={`tel:+91${o.phone}`} className="inline-flex items-center gap-1 text-action">
                <Phone className="h-3.5 w-3.5" aria-hidden /> {o.phone}
              </a>
            )}
            <span className="text-ink-muted">{o.channel === 'online' ? 'Sent online' : 'Taken at counter'} · {dateLabel(o.createdAt)}</span>
          </div>
        </div>
        <button onClick={onClose} className="rounded p-2 hover:bg-surface-tint" aria-label="Close">
          <X className="h-6 w-6" />
        </button>
      </div>

      <div className="flex-1 space-y-4 p-4">
        {error && <Banner tone="danger">{error}</Banner>}

        {/* Next step */}
        {open && mode === null && (
          <div className="space-y-2 rounded border-2 border-action bg-surface-tint p-3">
            {o.state === 'requested' && (
              <>
                <p className="text-sm">Check the file and the details, then send the price.</p>
                <Button className="w-full" onClick={() => setMode('quote')}>
                  Send price
                </Button>
              </>
            )}
            {o.state === 'quoted' && (
              <>
                <p className="text-sm">
                  Advance asked: <b className="font-mono">{rupees(o.advancePaise)}</b> of {rupees(o.totalPaise)}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={() => setMode('pay')}>Record advance</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => act('confirm')}>
                    Start without advance
                  </Button>
                </div>
              </>
            )}
            {step && (
              <>
                {blocked(step.to) && (
                  <p className="text-sm text-attention">
                    {svc.proof === 'text' ? 'Waiting for the customer to approve the text before printing.' : 'Waiting for the student to approve the cover text before binding.'}
                  </p>
                )}
                <Button className="w-full" disabled={busy || blocked(step.to)} onClick={() => act('stage', { stage: step.to })}>
                  {step.label}
                </Button>
                {o.state === 'printing' && binds && (
                  <Button variant="ghost" size="sm" className="w-full" disabled={busy || blocked('ready')} onClick={() => act('stage', { stage: 'ready' })}>
                    Skip binding — mark ready
                  </Button>
                )}
              </>
            )}
            {o.state === 'ready' && (
              <>
                <p className="text-sm">{bal > 0 ? <>Collect the balance <b className="font-mono">{rupees(bal)}</b> and hand over the books.</> : 'Fully paid — hand over the books.'}</p>
                {bal > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="ready" disabled={busy} onClick={() => act('deliver', { method: 'cash' })}>
                      Cash · Delivered
                    </Button>
                    <Button variant="ready" disabled={busy} onClick={() => act('deliver', { method: 'upi' })}>
                      UPI · Delivered
                    </Button>
                  </div>
                ) : (
                  <Button variant="ready" className="w-full" disabled={busy} onClick={() => act('deliver')}>
                    <Check className="h-5 w-5" aria-hidden /> Delivered
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => act('stage', { stage: binds ? 'binding' : 'printing' })}>
                  Not ready after all — {binds ? 'back to binding' : 'back to work'}
                </Button>
              </>
            )}
          </div>
        )}

        {mode === 'quote' && <QuoteEditor v={v} busy={busy} onCancel={() => setMode(null)} onSave={(lines, advance) => act('quote', { lines, advancePaise: advance })} />}
        {mode === 'pay' && <PayForm kind={o.state === 'quoted' ? 'advance' : 'balance'} max={bal} initial={o.state === 'quoted' ? Math.min(o.advancePaise || bal, bal) : bal} busy={busy} onCancel={() => setMode(null)} onSave={(method, paise, kind) => act('pay', { kind, method, paise })} />}
        {mode === 'cancel' && <CancelForm paid={o.paidPaise} busy={busy} onCancel={() => setMode(null)} onSave={(reason, method) => act('cancel', { reason, method })} />}
        {mode === 'cover' && <CoverForm svc={svc} cover={o.cover} busy={busy} onCancel={() => setMode(null)} onSave={(c) => act('cover', { cover: c })} />}
        {mode === 'details' && <DetailsForm o={o} busy={busy} onCancel={() => setMode(null)} onSave={(b) => act('details', b)} />}

        {/* Money */}
        <Section title="Price & payments" action={open && o.state !== 'requested' && o.state !== 'ready' && mode === null ? <SmallBtn onClick={() => setMode('quote')}>Edit price</SmallBtn> : undefined}>
          {o.lines.length === 0 ? (
            <p className="text-sm text-ink-muted">No price sent yet.</p>
          ) : (
            <div className="space-y-1 text-sm">
              {o.lines.map((l, i) => (
                <div key={i} className="flex justify-between gap-3">
                  <span>{l.label}</span>
                  <span className="font-mono tabular">{rupees(l.paise)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-divider pt-1 font-bold">
                <span>Total</span>
                <span className="font-mono">{rupees(o.totalPaise)}</span>
              </div>
            </div>
          )}
          {o.payments.length > 0 && (
            <div className="space-y-1 border-t border-divider pt-2 text-sm">
              {o.payments.map((p) => (
                <div key={p.id} className="flex justify-between gap-3">
                  <span>
                    <span className="capitalize">{p.kind}</span> · {p.method.toUpperCase()} · {dateLabel(p.at)} {clock(p.at)} · {p.by}
                  </span>
                  <span className={`font-mono tabular ${p.paise < 0 ? 'text-danger' : ''}`}>{rupees(p.paise)}</span>
                </div>
              ))}
            </div>
          )}
          {o.totalPaise > 0 && (
            <div className="flex items-baseline justify-between rounded bg-surface-tint p-3">
              <span className="font-semibold">Balance</span>
              <span className={`font-mono text-xl font-bold ${bal === 0 ? 'text-ready' : ''}`}>{bal === 0 ? 'Paid' : rupees(bal)}</span>
            </div>
          )}
          {open && o.state !== 'requested' && o.state !== 'quoted' && bal > 0 && mode === null && (
            <SmallBtn onClick={() => setMode('pay')}>Record a payment</SmallBtn>
          )}
        </Section>

        {/* Proof: cover text (blackbook, thesis) or the words to print (cards, stamps, banners) */}
        {svc.proof && (
        <Section
          title={proofName(svc)}
          action={canEditProof && mode === null ? <SmallBtn onClick={() => setMode('cover')}><Pencil className="h-3.5 w-3.5" aria-hidden /> Edit</SmallBtn> : undefined}
        >
          {o.cover.title || o.cover.text ? (
            <>
              {svc.proof === 'text' ? (
                <pre className="whitespace-pre-wrap rounded border-[1.5px] border-line p-3 font-sans text-sm font-semibold">{o.cover.text}</pre>
              ) : (
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
                  {COVER_FIELDS.filter((f) => o.cover[f.k]).map((f) => (
                    <div key={f.k} className="contents">
                      <dt className="text-ink-muted">{f.label}</dt>
                      <dd className="font-semibold">{o.cover[f.k]}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {coverOk ? (
                <p className="flex items-center gap-1 text-sm text-ready">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Customer approved this on {dateLabel(o.coverApprovedAt)}
                </p>
              ) : (
                open && <p className="text-sm text-attention">Not approved by the customer yet. Share the order link so they can check it.</p>
              )}
              <SmallBtn onClick={() => printSlip(o)}>
                <Printer className="h-3.5 w-3.5" aria-hidden /> {svc.proof === 'cover' ? 'Print slip for binder' : 'Print job slip'}
              </SmallBtn>
            </>
          ) : open ? (
            <p className="text-sm text-attention">Not given yet — add it, or share the order link so the customer can.</p>
          ) : (
            <p className="text-sm text-ink-muted">Details removed after delivery (privacy).</p>
          )}
        </Section>
        )}

        {/* What to make */}
        <Section title="What to make" action={open && mode === null ? <SmallBtn onClick={() => setMode('details')}>Edit</SmallBtn> : undefined}>
          <div className="flex flex-wrap gap-1.5 text-sm">
            <Chip>
              <ServiceIcon id={o.kind} className="h-3.5 w-3.5" /> {svc.name}
            </Chip>
            {svc.form === 'document' && (
              <>
                <Chip>{o.spec.copies ?? 1} copies</Chip>
                <Chip>{BINDING_LABEL[o.spec.binding ?? 'none']}</Chip>
                <Chip>{o.spec.pages ? `${o.spec.pages} pages` : 'Pages: count from file'}</Chip>
                {o.spec.colourPages && <Chip tone="action">Colour: {o.spec.colourPages}</Chip>}
                {o.spec.bothSides && <Chip>Both sides</Chip>}
              </>
            )}
            {svc.form === 'quantity' && (
              <>
                <Chip>
                  {o.spec.quantity ?? 0} {svc.unit ? UNIT_EN[svc.unit] : ''}
                </Chip>
                {o.spec.size && <Chip>Size: {o.spec.size}</Chip>}
              </>
            )}
          </div>
          {svc.form === 'custom' && o.spec.description && <p className="whitespace-pre-line rounded bg-surface-tint p-2 text-sm">{o.spec.description}</p>}
          {o.spec.notes && <p className="rounded bg-surface-tint p-2 text-sm">“{o.spec.notes}”</p>}
        </Section>

        {/* Files */}
        <Section title="Files">
          {o.files.length === 0 && <p className="text-sm text-ink-muted">No files yet. Share the order link so the customer can add them.</p>}
          {o.files.map((f, i) => (
            <div key={f.id} className="flex flex-wrap items-center gap-2 rounded border-[1.5px] border-line p-2 text-sm">
              <FileText className="h-4 w-4 text-ink-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-semibold">{f.filename || `File ${i + 1} (deleted)`}</span>
              {f.downloads > 0 && (
                <Chip tone="attention">
                  <Download className="h-3 w-3" aria-hidden /> {f.downloadedBy} · {clock(f.downloadedAt)}
                </Chip>
              )}
              {!f.deletedAt && f.uploadStatus === 'uploaded' && (
                <Button size="sm" variant="secondary" onClick={() => download(f.id, f.filename)}>
                  <Download className="h-4 w-4" aria-hidden /> Download
                </Button>
              )}
              {f.uploadStatus !== 'uploaded' && !f.deletedAt && <Chip>Uploading…</Chip>}
            </div>
          ))}
          {downloaded && !o.copiesDeletedAt && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => window.confirm('Confirm you deleted every downloaded copy from this computer — Downloads folder and Recycle Bin?') && act('copies-deleted')}>
              <Trash2 className="h-4 w-4" aria-hidden /> Copies deleted
            </Button>
          )}
          {o.copiesDeletedAt && <p className="text-sm text-ready">Downloaded copies deleted by {o.copiesDeletedBy} · {dateLabel(o.copiesDeletedAt)}</p>}
          {o.filesDeletedAt && <p className="text-sm text-ready">Files deleted from Counter Drop on {dateLabel(o.filesDeletedAt)}.</p>}
        </Section>

        {/* History */}
        <Section title="History">
          <ol className="space-y-1 text-sm">
            {[...o.history].reverse().map((h, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {h.action.replace(/_/g, ' ')}
                  {h.note ? ` · ${h.note}` : ''}
                  {h.by ? <span className="text-ink-muted"> · {h.by}</span> : null}
                </span>
                <span className="shrink-0 text-ink-muted">
                  {dateLabel(h.at)} {clock(h.at)}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      {open && mode === null && (
        <div className="grid grid-cols-2 gap-2 border-t border-line p-4">
          <Button variant="secondary" disabled={busy} onClick={() => act('link')}>
            <Link2 className="h-4 w-4" aria-hidden /> Student link
          </Button>
          <Button variant="danger" onClick={() => setMode('cancel')}>
            Cancel order
          </Button>
        </div>
      )}
    </>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function SmallBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-semibold text-action hover:bg-surface-tint">
      {children}
    </button>
  )
}

function FormBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded border-2 border-action p-3">
      <h3 className="font-bold">{title}</h3>
      {children}
    </div>
  )
}

function FormButtons({ busy, onCancel, label, disabled, variant }: { busy: boolean; onCancel: () => void; label: string; disabled?: boolean; variant?: 'primary' | 'danger' | 'ready' }) {
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
        Back
      </Button>
      <Button type="submit" variant={variant} className="flex-1" disabled={busy || disabled}>
        {busy ? <Spinner /> : null} {label}
      </Button>
    </div>
  )
}

function QuoteEditor({ v, busy, onCancel, onSave }: { v: ShopOrderView; busy: boolean; onCancel: () => void; onSave: (lines: OrderLine[], advance: number) => void }) {
  const start = v.order.lines.length ? v.order.lines : v.suggested
  const [rows, setRows] = useState(() => (start.length ? start : [{ label: '', paise: 0 }]).map((l) => ({ label: l.label, rs: toRs(l.paise) })))
  const total = rows.reduce((s, r) => s + toPaise(r.rs), 0)
  const suggestAdvance = (t: number) => Math.round((t * v.settings.advancePercent) / 100 / 100) * 100
  const [advance, setAdvance] = useState(() => toRs(v.order.advancePaise || suggestAdvance(total)))
  const [touched, setTouched] = useState(!!v.order.advancePaise)
  const adv = touched ? toPaise(advance) : suggestAdvance(total)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave(
          rows.filter((r) => r.label.trim() || toPaise(r.rs)).map((r) => ({ label: r.label, paise: toPaise(r.rs) })),
          adv,
        )
      }}
    >
      <FormBox title="Price">
        {!v.order.spec.pages && <p className="text-sm text-attention">Pages unknown — open the file, count, and add a printing line (or set pages under “What to make” to get a suggestion).</p>}
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            <span>Item</span>
            <span className="text-right">₹</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] gap-2">
              <input className={`${rowInput} w-full min-w-0`} value={r.label} placeholder="e.g. Printing B/W · 80 pages × 3" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Line" />
              <input className={`${rowInput} w-full min-w-0 text-right font-mono`} inputMode="decimal" value={r.rs} placeholder="₹" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rs: e.target.value.replace(/[^0-9.]/g, '') } : x)))} aria-label="Amount in rupees" />
              <button type="button" className="w-8 p-2 text-ink-muted hover:text-danger" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove line">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <SmallBtn onClick={() => setRows([...rows, { label: '', rs: '' }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add line (CD pocket, extra copy…)
          </SmallBtn>
        </div>
        <div className="flex items-center justify-between gap-3 rounded bg-surface-tint p-3">
          <span className="font-semibold">Total</span>
          <span className="font-mono text-xl font-bold">{rupees(total)}</span>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm font-semibold">
          Advance to ask (₹)
          <input
            className={`${rowInput} w-32 shrink-0 text-right font-mono`}
            inputMode="decimal"
            value={touched ? advance : toRs(adv)}
            onChange={(e) => {
              setTouched(true)
              setAdvance(e.target.value.replace(/[^0-9.]/g, ''))
            }}
          />
        </label>
        <FormButtons busy={busy} onCancel={onCancel} label="Send price" disabled={total <= 0 || adv > total} />
      </FormBox>
    </form>
  )
}

function PayForm({ kind, max, initial, busy, onCancel, onSave }: { kind: 'advance' | 'balance'; max: number; initial: number; busy: boolean; onCancel: () => void; onSave: (method: 'cash' | 'upi', paise: number, kind: string) => void }) {
  const [rs, setRs] = useState(toRs(initial))
  const paise = toPaise(rs)
  const ok = paise > 0 && paise <= max
  return (
    <FormBox title={kind === 'advance' ? 'Record advance' : 'Record payment'}>
      <label className="block text-sm font-semibold">
        Amount (₹) <span className="font-normal text-ink-muted">· up to {rupees(max)}</span>
        <input className={`${input} font-mono text-xl`} inputMode="decimal" autoFocus value={rs} onChange={(e) => setRs(e.target.value.replace(/[^0-9.]/g, ''))} />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Back
        </Button>
        <Button type="button" disabled={busy || !ok} onClick={() => onSave('cash', paise, kind)}>
          Cash
        </Button>
        <Button type="button" disabled={busy || !ok} onClick={() => onSave('upi', paise, kind)}>
          UPI
        </Button>
      </div>
    </FormBox>
  )
}

function CancelForm({ paid, busy, onCancel, onSave }: { paid: number; busy: boolean; onCancel: () => void; onSave: (reason: string, refundMethod: string) => void }) {
  const [reason, setReason] = useState('')
  const [refund, setRefund] = useState<'' | 'cash' | 'upi'>('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave(reason, refund)
      }}
    >
      <FormBox title="Cancel order">
        <label className="block text-sm font-semibold">
          Reason (the customer sees it)
          <input className={input} value={reason} maxLength={140} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Student changed the shop" />
        </label>
        {paid > 0 && (
          <div className="space-y-1 text-sm">
            <div className="font-semibold">{rupees(paid)} was paid</div>
            {(
              [
                ['', 'Keep the advance'],
                ['cash', `Refund ${rupees(paid)} in cash`],
                ['upi', `Refund ${rupees(paid)} by UPI`],
              ] as const
            ).map(([val, label]) => (
              <label key={val} className="flex items-center gap-2">
                <input type="radio" name="refund" checked={refund === val} onChange={() => setRefund(val)} className="h-4 w-4 accent-[var(--action)]" /> {label}
              </label>
            ))}
          </div>
        )}
        <FormButtons busy={busy} onCancel={onCancel} label="Cancel order" variant="danger" disabled={!reason.trim()} />
      </FormBox>
    </form>
  )
}

function CoverFields({ cover, onChange }: { cover: CoverText; onChange: (c: CoverText) => void }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
      {COVER_FIELDS.map((f) => (
        <label key={f.k} className={`block text-sm font-semibold ${f.wide ? 'col-span-2' : ''}`}>
          {f.label}
          <input className={input} value={cover[f.k] ?? ''} onChange={(e) => onChange({ ...cover, [f.k]: e.target.value })} />
        </label>
      ))}
    </div>
  )
}

function CoverForm({ svc, cover, busy, onCancel, onSave }: { svc: ServiceDef; cover: CoverText; busy: boolean; onCancel: () => void; onSave: (c: CoverText) => void }) {
  const [c, setC] = useState(cover)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave(c)
      }}
    >
      <FormBox title={proofName(svc)}>
        <p className="text-sm text-attention">Any change asks the customer to approve it again.</p>
        <ProofFields svc={svc} cover={c} onChange={setC} />
        <FormButtons busy={busy} onCancel={onCancel} label="Save" />
      </FormBox>
    </form>
  )
}

/** The cover fields or a text box, for services that need the customer's approval. */
function ProofFields({ svc, cover, onChange }: { svc: ServiceDef; cover: CoverText; onChange: (c: CoverText) => void }) {
  if (svc.proof === 'text') {
    return (
      <label className="block text-sm font-semibold">
        Text to print <span className="font-normal text-ink-muted">· every word, as it should appear</span>
        <textarea className={`${input} h-28 py-2 font-mono text-sm`} value={cover.text ?? ''} maxLength={1000} onChange={(e) => onChange({ ...cover, text: e.target.value })} />
      </label>
    )
  }
  return <CoverFields cover={cover} onChange={onChange} />
}

/** What to make, for the service's kind of form (document, quantity or described in words). */
function SpecEditor({ svc, spec, onChange }: { svc: ServiceDef; spec: OrderSpec; onChange: (s: OrderSpec) => void }) {
  const set = (p: Partial<OrderSpec>) => onChange({ ...spec, ...p })
  const bindings: Binding[] = svc.id === 'bulk' || svc.id === 'binding' ? ['none', 'spiral', 'soft', 'hard'] : ['hard', 'spiral', 'soft']
  return (
    <div className="space-y-2">
      {svc.form === 'document' && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Copies</span>
            <Stepper label="Copies" value={spec.copies ?? 1} max={svc.id === 'bulk' ? 1000 : 50} onChange={(copies) => set({ copies })} />
          </div>
          <label className="block text-sm font-semibold">
            Binding
            <select className={input} value={spec.binding ?? svc.binding} onChange={(e) => set({ binding: e.target.value as Binding })}>
              {bindings.map((b) => (
                <option key={b} value={b}>
                  {BINDING_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-semibold">
              Pages in one copy
              <input className={input} inputMode="numeric" value={spec.pages ? String(spec.pages) : ''} onChange={(e) => set({ pages: Number(e.target.value.replace(/\D/g, '').slice(0, 4)) || 0 })} />
            </label>
            <label className="block text-sm font-semibold">
              Colour pages
              <input className={input} value={spec.colourPages ?? ''} placeholder="1,5-7" onChange={(e) => set({ colourPages: e.target.value })} />
            </label>
          </div>
        </>
      )}
      {svc.form === 'quantity' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-semibold">
            How many {svc.unit ? UNIT_EN[svc.unit] : ''}
            <input className={`${input} font-mono`} inputMode="numeric" value={spec.quantity ? String(spec.quantity) : ''} onChange={(e) => set({ quantity: Number(e.target.value.replace(/\D/g, '').slice(0, 6)) || 0 })} />
          </label>
          <label className="block text-sm font-semibold">
            Size
            <input className={input} value={spec.size ?? ''} maxLength={40} placeholder="e.g. 6 × 3 ft" onChange={(e) => set({ size: e.target.value })} />
          </label>
        </div>
      )}
      {svc.form === 'custom' && (
        <label className="block text-sm font-semibold">
          What they need
          <textarea className={`${input} h-24 py-2`} value={spec.description ?? ''} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
        </label>
      )}
      <label className="block text-sm font-semibold">
        Notes
        <input className={input} value={spec.notes ?? ''} maxLength={500} onChange={(e) => set({ notes: e.target.value })} />
      </label>
    </div>
  )
}

/** A fresh spec for a service, with its defaults. */
function newSpec(svc: ServiceDef): OrderSpec {
  if (svc.form === 'document') return { copies: svc.copies ?? 1, binding: svc.binding ?? 'spiral', bothSides: false, pages: 0, colourPages: '', notes: '' }
  if (svc.form === 'quantity') return { quantity: 0, size: '', notes: '' }
  return { description: '', notes: '' }
}

function DetailsForm({ o, busy, onCancel, onSave }: { o: Order; busy: boolean; onCancel: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const [name, setName] = useState(o.customerName ?? '')
  const [phone, setPhone] = useState(o.phone ?? '')
  const [due, setDue] = useState(o.dueDate)
  const svc = serviceOf(o.kind)
  const [spec, setSpec] = useState<OrderSpec>({ ...newSpec(svc), ...o.spec })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ customerName: name, phone, dueDate: due, spec })
      }}
    >
      <FormBox title="Order details">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-semibold">
            Name
            <input className={input} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm font-semibold">
            Mobile
            <input className={input} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
        <label className="block text-sm font-semibold">
          Delivery date
          <input className={input} type="date" min={todayIST()} value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <SpecEditor svc={svc} spec={spec} onChange={setSpec} />
        <FormButtons busy={busy} onCancel={onCancel} label="Save" />
      </FormBox>
    </form>
  )
}

function NewOrder({ settings, onClose, onCreated }: { settings: OrderSettings; onClose: () => void; onCreated: (v: ShopOrderView) => void }) {
  const { call } = useShopAuth()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const offered = SERVICES.filter((x) => settings.services.some((s) => s.id === x.id && s.enabled))
  const choices = offered.length ? offered : SERVICES
  const [svcId, setSvcId] = useState(choices[0]!.id)
  const svc = serviceOf(svcId)
  const leadOf = (id: string) => settings.services.find((s) => s.id === id)?.leadDays ?? 1
  const [due, setDue] = useState(addDays(todayIST(), Math.max(1, leadOf(choices[0]!.id))))
  const [spec, setSpec] = useState<OrderSpec>(newSpec(choices[0]!))
  const [cover, setCover] = useState<CoverText>({ title: '', student: '', college: '' })
  const pickService = (id: string) => {
    setSvcId(id)
    setSpec(newSpec(serviceOf(id)))
    setDue(addDays(todayIST(), Math.max(1, leadOf(id))))
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const v = await call<ShopOrderView>('/shop/orders', {
        body: { service: svcId, customerName: name, phone, dueDate: due, cover: svc.proof ? cover : {}, spec },
      })
      onCreated(v)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the order')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[rgba(15,23,42,0.72)]" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col overflow-auto border-l-2 border-ink bg-surface" onClick={(e) => e.stopPropagation()} aria-label="New order">
        <div className="flex items-center gap-3 border-b border-line p-4">
          <ServiceIcon id={svcId} className="h-6 w-6 text-action" />
          <h2 className="flex-1 text-xl font-bold">New order</h2>
          <button onClick={onClose} className="rounded p-2 hover:bg-surface-tint" aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
        <form
          className="flex-1 space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label className="block text-sm font-semibold">
            What
            <select className={input} value={svcId} onChange={(e) => pickService(e.target.value)}>
              {choices.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-semibold">
              Customer name
              <input className={input} value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block text-sm font-semibold">
              Mobile (optional)
              <input className={input} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>
          <label className="block text-sm font-semibold">
            Delivery date
            <input className={input} type="date" min={todayIST()} value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <SpecEditor svc={svc} spec={spec} onChange={setSpec} />
          {svc.proof && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{proofName(svc)} (optional now — the customer can add it from the link)</h3>
              <ProofFields svc={svc} cover={cover} onChange={setCover} />
            </div>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? <Spinner /> : null} Create order
          </Button>
          <p className="text-center text-xs text-ink-muted">Next: send the price, take the advance, and share the link so the customer can add files and approve the text.</p>
        </form>
      </aside>
    </div>
  )
}

function LinkDialog({ view, secret, onClose }: { view: ShopOrderView; secret: string; onClose: () => void }) {
  const o = view.order
  const url = `${window.location.origin}/o/${o.id}#${secret}`
  const [copied, setCopied] = useState(false)
  const svc = serviceOf(o.kind)
  const msg = `Your order ${o.code} (${svc.name.toLowerCase()}): ${svc.proof ? 'check the text, ' : ''}add your files and track it here — ${url}`
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.72)] p-4" onClick={onClose}>
      <div role="dialog" aria-label="Student link" className="w-full max-w-md space-y-3 rounded border-2 border-ink bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">
          Send <span className="font-mono">{o.code}</span> to the customer
        </h2>
        <p className="text-sm text-ink-muted">They can add files, {svc.proof ? 'approve the text ' : ''}and track the order. A new link replaces any older one.</p>
        <div className="break-all rounded bg-surface-tint p-3 font-mono text-xs">{url}</div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard?.writeText(msg).catch(() => {})
              setCopied(true)
            }}
          >
            <Copy className="h-4 w-4" aria-hidden /> {copied ? 'Copied' : 'Copy message'}
          </Button>
          <a
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded bg-ready px-4 font-semibold text-white"
            href={`https://wa.me/${o.phone ? '91' + o.phone : ''}?text=${encodeURIComponent(msg)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            WhatsApp
          </a>
        </div>
        <Button variant="ghost" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

/** A printable slip with the cover text, for the binder. */
function printSlip(o: Order) {
  const w = window.open('', '_blank', 'width=600,height=800')
  if (!w) return
  const svc = serviceOf(o.kind)
  const esc = (s?: string) => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  const body =
    svc.proof === 'text'
      ? `<pre style="font:600 18px system-ui,sans-serif;white-space:pre-wrap;border:1px solid #94a3b8;padding:12px">${esc(o.cover.text)}</pre>`
      : `<table>${COVER_FIELDS.filter((f) => o.cover[f.k])
          .map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(o.cover[f.k])}</td></tr>`)
          .join('')}</table>`
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.code)} slip</title>
<style>body{font:15px system-ui,sans-serif;margin:24px;color:#0f172a}h1{font-size:28px;margin:0}table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{border:1px solid #94a3b8;padding:8px;text-align:left;vertical-align:top}th{width:35%;background:#f1f5f9}.meta{margin-top:6px;color:#334155}</style></head>
<body><h1>${esc(o.code)} · ${esc(o.customerName)}</h1>
<div class="meta">${esc(svc.name)} · ${esc(summary(o))} · due ${esc(dueLabel(o.dueDate))}${o.coverApprovedAt ? ' · approved by customer' : ' · NOT APPROVED YET'}</div>
${body}${o.spec.notes ? `<p><b>Notes:</b> ${esc(o.spec.notes)}</p>` : ''}
<script>window.onload=()=>window.print()</script></body></html>`)
  w.document.close()
}
