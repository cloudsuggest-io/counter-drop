// Mirrors the Go API (api/internal/domain, httpapi). Money is integer paise.

export type JobState = 'uploading' | 'queued' | 'claimed' | 'ready' | 'collected' | 'cancelled'
export type OnlineState = 'online' | 'paused' | 'offline'

export interface FileSettings {
  copies: number
  colour: boolean
  bothSides: boolean
  pageRange?: string
  /** Sent for something other than printing; the shop sets the price. */
  other?: boolean
  note?: string
}

export interface JobFile {
  id: string
  filename: string
  size: number
  mime: string
  pages: number
  /** confirmed: the phone couldn't count the pages (Word, Excel…) and staff entered them. */
  pagesStatus: 'pending' | 'counted' | 'unknown' | 'confirmed'
  settings: FileSettings
  uploadStatus: 'pending' | 'uploaded'
  deleteStatus: 'active' | 'pending' | 'deleted' | 'failed'
  deleteAfter?: string
  deletedAt?: string
  printedAt?: string
  printOpens: number
  downloadedAt?: string
  downloadedBy?: string
  downloads: number
}

export interface Job {
  id: string
  shopId: string
  channel: 'walkin' | 'remote'
  laneId?: string
  lane?: string
  token?: string
  customerName?: string
  files: JobFile[]
  state: JobState
  priceTotalPaise: number
  pagesTotal: number
  pagesToConfirm: boolean
  readyBy?: string
  claimedBy?: string
  cancelReason?: string
  paidMethod?: string
  /** The shop's price for Other files, included in priceTotalPaise; absent until set. */
  otherPricePaise?: number
  noReceipt?: boolean
  createdAt: string
  updatedAt: string
  queuedAt?: string
  claimedAt?: string
  readyAt?: string
  collectedAt?: string
  cancelledAt?: string
  filesDeletedAt?: string
  copiesDeleteRequestedAt?: string
  copiesDeletedAt?: string
  copiesDeletedBy?: string
}

export interface PriceList {
  bwOnePaise: number
  bwBothPaise: number
  colourOnePaise: number
  colourBothPaise: number
  minChargePaise: number
  version: number
}

export interface Wait {
  jobsAhead: number
  lowMinutes: number
  highMinutes: number
}

export interface PublicShop {
  id: string
  slug: string
  name: string
  address: string
  onlineState: OnlineState
  pauseMessage?: string
  isOpen: boolean
  opensAt: string
  closesAt: string
  prices: PriceList
  colourAvailable: boolean
  wait: Wait
  holdDays: number
}

export interface QuoteLine {
  fileId: string
  selectedPages: number
  sheets: number
  sides: number
  copies: number
  colour: boolean
  bothSides: boolean
  unitPaise: number
  unit: 'side' | 'sheet'
  amountPaise: number
  other?: boolean
}

export interface Quote {
  lines: QuoteLine[]
  subtotalPaise: number
  minChargePaise: number
  totalPaise: number
  pagesTotal: number
  pagesToConfirm: boolean
  priceVersion: string
  otherFiles: number
}

export interface Ticket {
  job: Job
  quote?: Quote
  position: number
  shop: PublicShop
  undoUntil?: string
  holdUntil?: string
  serverTime: string
}

export interface UploadTarget {
  fileId: string
  clientId: string
  url: string
  method: 'PUT'
  headers: Record<string, string>
}

export interface Lane {
  id: string
  letter: string
  name: string
  rule: 'bw' | 'colour' | 'any'
}

export interface Shop {
  id: string
  slug: string
  name: string
  address: string
  status: string
  onlineState: OnlineState
  pauseMessage?: string
  timezone: string
  opensAt: string
  closesAt: string
  prices: PriceList
  lanes: Lane[]
  holdDays: number
}

export interface Staff {
  id: string
  shopId: string
  name: string
  role: 'owner' | 'staff'
}

export interface QueueSnapshot {
  shop: Shop
  jobs: Job[]
  copiesToDelete: Job[]
  todayCount: number
  wait: Wait
  undoWindowSeconds: number
  serverTime: string
}

export interface StaffMember {
  id: string
  name: string
  role: 'owner' | 'staff'
  pending: boolean
  pinSetAt?: string
  createdAt: string
}

export interface SetupLinkOut {
  purpose: 'setup' | 'reset'
  expiresAt: string
  setupPath: string
  setupUrl: string
}

export interface SetupInfo {
  shopName: string
  shopSlug: string
  staffName: string
  role: 'owner' | 'staff'
  purpose: 'setup' | 'reset'
  expiresAt: string
}

/** GET /shop/dashboard?days=1|7|30 (owner only). Mirrors store.Dashboard; seconds and paise. */
export interface Dashboard {
  days: 1 | 7 | 30
  from: string
  to: string
  serverTime: string
  earnings: { totalPaise: number; cashPaise: number; upiPaise: number; unrecordedPaise: number; unrecordedJobs: number }
  previous: { paise: number; jobs: number; label: string }
  jobs: { submitted: number; collected: number; cancelled: number; files: number; avgBillPaise: number; maxBillPaise: number }
  pages: {
    printed: number
    sheets: number
    bw: number
    colour: number
    oneSide: number
    bothSides: number
    pdfFiles: number
    photoFiles: number
    docFiles: number
    otherFiles: number
    otherPaise: number
  }
  speed: { waitSec: number; printSec: number; pickupSec: number; withinTenPct: number; samples: number }
  hours: { hour: number; jobs: number; prev: number }[]
  series: { day: string; paise: number; jobs: number; prevPaise: number; prevJobs: number }[]
  staff: { name: string; jobs: number; pages: number; avgPrintSec: number; cashPaise: number; upiPaise: number }[]
  now: { inLine: number; printing: number; ready: number; oldestReadyToken?: string; oldestReadyMin: number; copiesToConfirm: number; pagesToConfirm: number }
  problems: { cancelledByCustomer: number; cancelledByShop: number; notCollected: number; noReceipt: number; longWaits: number }
  filesDeleted: number
}
