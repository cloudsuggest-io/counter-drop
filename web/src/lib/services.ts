import type { Binding, OrderState, ServiceSetting } from './types'

// The order services. Mirrors domain.Catalogue in the API (same IDs, order and rules); the API
// stores each shop's on/off, price and days needed. Names are translated by `svc_<id>` keys for
// customers; shop screens use the English `name`.

export type ServiceForm = 'document' | 'quantity' | 'custom'
export type Proof = '' | 'cover' | 'text'
export type Unit = 'cards' | 'sheets' | 'stamps' | 'sqft' | 'photos' | 'pages'

export interface ServiceDef {
  id: string
  name: string
  form: ServiceForm
  proof: Proof
  /** Work can't pass this stage until the customer approves the proof. */
  proofBefore?: OrderState
  unit?: Unit
  unitSize?: number
  binding?: Binding
  copies?: number // default copies for document services
  icon: string // emoji-free short glyph handled by the UI (lucide name)
}

export const SERVICES: ServiceDef[] = [
  { id: 'blackbook', name: 'Blackbook / project report', form: 'document', proof: 'cover', proofBefore: 'binding', binding: 'hard', copies: 3, icon: 'book' },
  { id: 'thesis', name: 'Thesis / dissertation', form: 'document', proof: 'cover', proofBefore: 'binding', binding: 'hard', copies: 2, icon: 'graduation' },
  { id: 'binding', name: 'Binding', form: 'document', proof: '', binding: 'spiral', copies: 1, icon: 'binder' },
  { id: 'bulk', name: 'Bulk printing', form: 'document', proof: '', binding: 'none', copies: 20, icon: 'layers' },
  { id: 'visiting', name: 'Visiting cards', form: 'quantity', proof: 'text', proofBefore: 'printing', unit: 'cards', unitSize: 100, icon: 'card' },
  { id: 'letterhead', name: 'Letterheads / bill books', form: 'quantity', proof: 'text', proofBefore: 'printing', unit: 'sheets', unitSize: 100, icon: 'letter' },
  { id: 'stamp', name: 'Rubber stamp', form: 'quantity', proof: 'text', proofBefore: 'printing', unit: 'stamps', unitSize: 1, icon: 'stamp' },
  { id: 'invitation', name: 'Invitation / wedding cards', form: 'quantity', proof: 'text', proofBefore: 'printing', unit: 'cards', unitSize: 100, icon: 'mail' },
  { id: 'flex', name: 'Flex banner / poster', form: 'quantity', proof: 'text', proofBefore: 'printing', unit: 'sqft', unitSize: 1, icon: 'banner' },
  { id: 'idcard', name: 'ID cards', form: 'quantity', proof: 'text', proofBefore: 'printing', unit: 'cards', unitSize: 1, icon: 'id' },
  { id: 'lamination', name: 'Lamination (bulk)', form: 'quantity', proof: '', unit: 'sheets', unitSize: 1, icon: 'shield' },
  { id: 'photo', name: 'Photo prints', form: 'quantity', proof: '', unit: 'photos', unitSize: 1, icon: 'image' },
  { id: 'scanning', name: 'Bulk scanning', form: 'quantity', proof: '', unit: 'pages', unitSize: 1, icon: 'scan' },
  { id: 'other', name: 'Something else', form: 'custom', proof: '', icon: 'more' },
]

const OTHER = SERVICES[SERVICES.length - 1]!

export function serviceOf(id: string | undefined): ServiceDef {
  return SERVICES.find((s) => s.id === id) ?? OTHER
}

/** English unit names for shop screens. */
export const UNIT_EN: Record<Unit, string> = { cards: 'cards', sheets: 'sheets', stamps: 'stamps', sqft: 'sq ft', photos: 'photos', pages: 'pages' }

/** Estimated price for a quantity service: whole lots of unitSize at the shop's unit price. */
export function quantityEstimate(svc: ServiceDef, setting: ServiceSetting | undefined, qty: number): number {
  const unit = setting?.unitPaise ?? 0
  if (!unit || qty <= 0) return 0
  const size = Math.max(svc.unitSize ?? 1, 1)
  return Math.ceil(qty / size) * unit
}

/** Whether a shop has passed the point where the proof had to be approved. */
const RANK: Partial<Record<OrderState, number>> = { confirmed: 0, printing: 1, binding: 2, ready: 3 }
export function proofLocked(svc: ServiceDef, state: OrderState): boolean {
  if (!svc.proof || !svc.proofBefore) return false
  const cur = RANK[state]
  return cur !== undefined && cur >= (RANK[svc.proofBefore] ?? 99)
}

/** Before the shop confirms the order, the customer may delete their files (API: StudentCanDeleteFiles). */
export const canDeleteFiles = (s: OrderState) => s === 'draft' || s === 'requested' || s === 'quoted'
