import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, LogOut } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { rupees } from '@/lib/format'
import type { OrderSettings, PriceList, Shop } from '@/lib/types'
import { SERVICES, UNIT_EN } from '@/lib/services'
import { ServiceIcon } from '@/components/ServiceIcon'
import { Banner, Button, Card, Spinner } from '@/components/ui'
import { useShopAuth, useShopTheme } from './auth'
import { StaffSection } from './StaffSection'

type Form = {
  name: string
  address: string
  opensAt: string
  closesAt: string
  bwOne: string
  bwBoth: string
  colourOne: string
  colourBoth: string
  minCharge: string
  holdDays: string
}

const toRs = (p: number) => (p ? String(p / 100) : '')
const toPaise = (v: string) => Math.round((Number(v.trim() || '0') || 0) * 100)

function fromShop(s: Shop): Form {
  return {
    name: s.name,
    address: s.address,
    opensAt: s.opensAt,
    closesAt: s.closesAt,
    bwOne: toRs(s.prices.bwOnePaise),
    bwBoth: toRs(s.prices.bwBothPaise),
    colourOne: toRs(s.prices.colourOnePaise),
    colourBoth: toRs(s.prices.colourBothPaise),
    minCharge: toRs(s.prices.minChargePaise),
    holdDays: String(s.holdDays || 7),
  }
}

// Owner settings (FSD SCR-S07, R1a subset): shop profile, hours and the price list.
export default function SettingsPage() {
  useShopTheme()
  const { session, call, setShop, logout } = useShopAuth()
  const [form, setForm] = useState<Form | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ready' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [orders, setOrders] = useState<OrderSettings | null>(null)

  useEffect(() => {
    call<Shop>('/shop/settings').then((s) => {
      setForm(fromShop(s))
      setOrders(s.orders)
    })
  }, [call])

  if (!form || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const prices: PriceList = {
      bwOnePaise: toPaise(form.bwOne),
      bwBothPaise: toPaise(form.bwBoth),
      colourOnePaise: toPaise(form.colourOne),
      colourBothPaise: toPaise(form.colourBoth),
      minChargePaise: toPaise(form.minCharge),
      version: session.shop.prices.version,
    }
    try {
      const s = await call<Shop>('/shop/settings', {
        method: 'PUT',
        body: { profile: { name: form.name.trim(), address: form.address.trim(), opensAt: form.opensAt, closesAt: form.closesAt, holdDays: Number(form.holdDays) }, prices },
      })
      setShop(s)
      setForm(fromShop(s))
      setMsg({ tone: 'ready', text: 'Saved. New jobs use these prices; jobs already sent keep their price.' })
    } catch (err) {
      setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  const input = 'mt-1 h-11 w-full rounded border-[1.5px] border-line bg-surface px-3'
  const bwOne = toPaise(form.bwOne)

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6 lg:max-w-6xl lg:py-8">
      <div className="flex items-center gap-3">
        <Link to="/shop" className="rounded p-2 hover:bg-surface-tint" aria-label="Back to queue">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <h1 className="flex-1 text-2xl font-bold">Shop settings</h1>
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="h-4 w-4" aria-hidden /> Sign out
        </Button>
      </div>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0">
        <div className="space-y-4">
        <form onSubmit={save} className="space-y-4">
          <Card className="space-y-3 p-4">
            <h2 className="text-lg font-bold">Shop</h2>
            <Field label="Shop name">
              <input className={input} value={form.name} onChange={set('name')} required minLength={3} maxLength={60} />
            </Field>
            <Field label="Address (shown to customers)">
              <input className={input} value={form.address} onChange={set('address')} maxLength={160} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Opens at">
                <input type="time" className={input} value={form.opensAt} onChange={set('opensAt')} required />
              </Field>
              <Field label="Closes at">
                <input type="time" className={input} value={form.closesAt} onChange={set('closesAt')} required />
              </Field>
            </div>
            <Field label="Close uncollected jobs after" hint="Jobs not collected by then are closed and their files deleted. Customers see the date on their ticket.">
              <select className={input} value={form.holdDays} onChange={(e) => setForm({ ...form, holdDays: e.target.value })}>
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-ink-muted">
              Link name: <span className="font-mono">{session.shop.slug}</span> (fixed — it's printed on your QR poster)
            </p>
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="text-lg font-bold">Prices (₹)</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="B/W · per side">
                <input inputMode="decimal" className={`${input} font-mono`} value={form.bwOne} onChange={set('bwOne')} required />
              </Field>
              <Field label="B/W · both sides, per sheet" hint={`Blank = ${rupees(bwOne * 2)}`}>
                <input inputMode="decimal" className={`${input} font-mono`} value={form.bwBoth} onChange={set('bwBoth')} />
              </Field>
              <Field label="Colour · per side" hint="Blank = no colour printing">
                <input inputMode="decimal" className={`${input} font-mono`} value={form.colourOne} onChange={set('colourOne')} />
              </Field>
              <Field label="Colour · both sides, per sheet" hint="Blank = 2 × per side">
                <input inputMode="decimal" className={`${input} font-mono`} value={form.colourBoth} onChange={set('colourBoth')} />
              </Field>
              <Field label="Minimum charge per job">
                <input inputMode="decimal" className={`${input} font-mono`} value={form.minCharge} onChange={set('minCharge')} />
              </Field>
            </div>
            <p className="text-xs text-ink-muted">Totals are rounded to the nearest rupee. Customers see these prices before they send.</p>
          </Card>

          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
        {orders && <OrderSettingsCard initial={orders} input={input} />}
        </div>

        <div className="lg:sticky lg:top-6">
          <StaffSection />
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-semibold">
      {label}
      {children}
      {hint && <span className="mt-1 block text-xs font-normal text-ink-muted">{hint}</span>}
    </label>
  )
}

const pct = (v: string) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
const DAY_CHOICES = [0, 1, 2, 3, 4, 5, 7, 10, 14]

/** Orders that take days (blackbooks, binding, cards…): which services, prices, advance (PUT /shop/order-settings). */
function OrderSettingsCard({ initial, input }: { initial: OrderSettings; input: string }) {
  const { call } = useShopAuth()
  const toForm = (o: OrderSettings) => ({
    enabled: o.enabled,
    hard: toRs(o.hardPaise),
    spiral: toRs(o.spiralPaise),
    soft: toRs(o.softPaise),
    advance: String(o.advancePercent),
    services: SERVICES.map((d) => {
      const s = o.services.find((x) => x.id === d.id)
      return { id: d.id, enabled: !!s?.enabled, price: toRs(s?.unitPaise ?? 0), lead: String(s?.leadDays ?? 1) }
    }),
  })
  const [f, setF] = useState(() => toForm(initial))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ready' | 'danger'; text: string } | null>(null)
  const set = (k: 'hard' | 'spiral' | 'soft' | 'advance') => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const setSvc = (id: string, p: Partial<(typeof f.services)[number]>) => setF({ ...f, services: f.services.map((s) => (s.id === id ? { ...s, ...p } : s)) })

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const s = await call<OrderSettings>('/shop/order-settings', {
        method: 'PUT',
        body: {
          enabled: f.enabled,
          hardPaise: toPaise(f.hard),
          spiralPaise: toPaise(f.spiral),
          softPaise: toPaise(f.soft),
          advancePercent: pct(f.advance),
          services: f.services.map((s) => ({ id: s.id, enabled: s.enabled, unitPaise: toPaise(s.price), leadDays: Number(s.lead) })),
        },
      })
      setF(toForm(s))
      setMsg({ tone: 'ready', text: 'Saved. New quotes use these prices.' })
    } catch (err) {
      setMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save}>
      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Orders that take days</h2>
            <p className="text-xs text-ink-muted">Blackbooks, binding, cards, banners… You quote, take an advance and collect the balance on delivery.</p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm font-semibold">
            <input type="checkbox" className="h-5 w-5 accent-[var(--action)]" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
            Take online
          </label>
        </div>

        <div className="divide-y divide-divider rounded border-[1.5px] border-line">
          {SERVICES.map((d) => {
            const s = f.services.find((x) => x.id === d.id)!
            return (
              <div key={d.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 p-2.5 ${s.enabled ? '' : 'opacity-60'}`}>
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--action)]" checked={s.enabled} onChange={(e) => setSvc(d.id, { enabled: e.target.checked })} />
                  <ServiceIcon id={d.id} className="h-4 w-4 shrink-0 text-ink-muted" />
                  <span className="truncate">{d.name}</span>
                </label>
                {d.form === 'quantity' && (
                  <label className="flex items-center gap-1 text-xs text-ink-muted">
                    ₹
                    <input
                      inputMode="decimal"
                      aria-label={`${d.name} price`}
                      className="h-9 w-20 rounded border-[1.5px] border-line bg-surface px-2 font-mono text-sm text-ink"
                      value={s.price}
                      onChange={(e) => setSvc(d.id, { price: e.target.value })}
                    />
                    {(d.unitSize ?? 1) > 1 ? `per ${d.unitSize} ${UNIT_EN[d.unit!]}` : `per ${UNIT_EN[d.unit!].replace(/s$/, '')}`}
                  </label>
                )}
                {d.form === 'document' && <span className="text-xs text-ink-muted">print rates + binding</span>}
                {d.form === 'custom' && <span className="text-xs text-ink-muted">you price each one</span>}
                <select aria-label={`${d.name} days needed`} className="h-9 rounded border-[1.5px] border-line bg-surface px-2 text-sm" value={s.lead} onChange={(e) => setSvc(d.id, { lead: e.target.value })}>
                  {[...new Set([...DAY_CHOICES, Number(s.lead)])].sort((x, y) => x - y).map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'Same day' : `${n} day${n === 1 ? '' : 's'}`}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Hard binding (₹/copy)" hint="Black, gold letters">
            <input inputMode="decimal" className={`${input} font-mono`} value={f.hard} onChange={set('hard')} />
          </Field>
          <Field label="Spiral (₹/copy)">
            <input inputMode="decimal" className={`${input} font-mono`} value={f.spiral} onChange={set('spiral')} />
          </Field>
          <Field label="Soft cover (₹/copy)">
            <input inputMode="decimal" className={`${input} font-mono`} value={f.soft} onChange={set('soft')} />
          </Field>
        </div>
        <Field label="Advance asked (%)" hint="Suggested on each quote; you can change it per order">
          <input inputMode="numeric" className={`${input} font-mono`} value={f.advance} onChange={set('advance')} />
        </Field>
        <p className="text-xs text-ink-muted">
          Printing is priced from your rates above. Days needed: customers can’t pick an earlier date. Files are kept until printing is done (at most 7 days) — customers agree to this when they send.
        </p>
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        <Button type="submit" variant="secondary" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save order settings'}
        </Button>
      </Card>
    </form>
  )
}
