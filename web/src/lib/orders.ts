import { store } from './api'
import type { Binding, Order, OrderState } from './types'

// Orders (blackbooks, binding, cards…) this phone has sent (or opened from a shop's link), so the student can come back
// to them over the days the order takes. Secrets never leave the device except in X-Ticket-Secret.

export interface SavedOrder {
  orderId: string
  secret: string
  slug: string
  shopName: string
  code: string
  savedAt: number
}

const KEY = 'cd.orders'
const KEEP_DAYS = 60

export function savedOrders(): SavedOrder[] {
  try {
    const list = JSON.parse(store.get(KEY) ?? '[]') as SavedOrder[]
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    return list.filter((o) => o.savedAt > cutoff)
  } catch {
    return []
  }
}

export function saveOrder(o: SavedOrder) {
  const rest = savedOrders().filter((x) => x.orderId !== o.orderId)
  store.set(KEY, JSON.stringify([o, ...rest].slice(0, 20)))
}

export function findOrder(orderId: string): SavedOrder | undefined {
  return savedOrders().find((o) => o.orderId === orderId)
}

/** Stage order for the progress bar the customer and staff see. */
export const STAGES: OrderState[] = ['requested', 'quoted', 'confirmed', 'printing', 'binding', 'ready', 'delivered']

export function stageIndex(s: OrderState): number {
  const i = STAGES.indexOf(s)
  return i < 0 ? 0 : i
}

export const BINDING_LABEL: Record<Binding, string> = {
  hard: 'Black hard binding, gold letters',
  spiral: 'Spiral binding',
  soft: 'Soft cover binding',
  none: 'No binding',
}

export const STATE_LABEL: Record<OrderState, string> = {
  draft: 'Draft',
  requested: 'Needs price',
  quoted: 'Waiting for advance',
  confirmed: 'Confirmed',
  printing: 'Printing',
  binding: 'At binder',
  ready: 'Ready',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

export const balanceOf = (o: Order) => Math.max(0, o.totalPaise - o.paidPaise)

const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayFmtLong = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

/** "2026-10-21" → "Wed, 21 Oct". */
export function dueLabel(day: string): string {
  if (!day) return ''
  return dayFmt.format(new Date(day + 'T12:00:00Z'))
}

/** ISO time → "21 Oct 2026" in IST. */
export function dateLabel(iso?: string): string {
  if (!iso) return ''
  return dayFmtLong.format(new Date(iso))
}

/** Today's date in IST as YYYY-MM-DD. */
export function todayIST(now = Date.now()): string {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Whole days from today (IST) to the due date; negative when late. */
export function daysUntil(day: string, now = Date.now()): number {
  return Math.round((new Date(day + 'T12:00:00Z').getTime() - new Date(todayIST(now) + 'T12:00:00Z').getTime()) / 86400000)
}
