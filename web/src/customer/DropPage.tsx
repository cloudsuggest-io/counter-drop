import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, BookOpen, FileText, FileType, Image as ImageIcon, Plus, ShieldCheck, Trash2, WifiOff, Clock, RotateCw } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { rupees, hhmm, bytes } from '@/lib/format'
import { checkPdf } from '@/lib/pdf'
import { uploadFile, mimeOf, fileKind, ACCEPTED, ALLOWED_MIMES } from '@/lib/upload'
import { saveTicket, savedTickets } from '@/lib/tickets'
import type { PublicShop, Ticket, UploadTarget, FileSettings } from '@/lib/types'
import { Banner, Button, Card, Chip, LangSwitch, Logo, Segmented, Spinner, Stepper } from '@/components/ui'
import { InstallCard } from '@/components/InstallCard'
import { LegalLinks } from './LegalPages'

const MAX_FILES = 20
const MAX_FILE_MB = 500
const MAX_JOB_MB = 500

type Status = 'checking' | 'uploading' | 'waiting' | 'done' | 'error' | 'locked'
interface LocalFile {
  clientId: string
  file: File
  mime: string
  fileId?: string
  pages: number
  status: Status
  progress: number
  error?: string
  pageRange: string
  /** Sent for something other than printing (attach to a form, laminate…): the shop sets the price. */
  other: boolean
  note: string
}

let seq = 0
const nextId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`

export default function DropPage() {
  const { slug = '' } = useParams()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [shop, setShop] = useState<PublicShop | null>(null)
  const [shopError, setShopError] = useState<string>('')
  const [files, setFiles] = useState<LocalFile[]>([])
  const [job, setJob] = useState<{ id: string; secret: string } | null>(null)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [settings, setSettings] = useState<FileSettings>({
    copies: 1,
    colour: false,
    bothSides: false,
  })
  const [name, setName] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const jobRef = useRef(job)
  jobRef.current = job

  const loadShop = useCallback(() => {
    api<PublicShop>(`/shops/${slug}`)
      .then((s) => {
        setShop(s)
        setShopError('')
      })
      .catch((e: ApiError) => setShopError(e.status === 404 ? t('notFound') : e.message))
  }, [slug, t])

  useEffect(loadShop, [loadShop])
  useEffect(() => {
    if (shop?.onlineState !== 'paused' && shop?.onlineState !== 'offline') return
    const id = window.setInterval(loadShop, 30000)
    return () => window.clearInterval(id)
  }, [shop?.onlineState, loadShop])

  const openTicket = useMemo(() => savedTickets().find((x) => x.slug === slug && x.token), [slug])

  // Uploads finish in parallel and each response carries a price snapshot. Apply a snapshot only if
  // no newer request has already been answered, so an out-of-order reply can't show a stale total.
  const seq = useRef(0)
  const applied = useRef(0)
  const [syncing, setSyncing] = useState(0)
  const nextSeq = () => ++seq.current
  const applyIf = (my: number, tk: Ticket) => {
    if (my > applied.current) {
      applied.current = my
      setTicket(tk)
    }
  }
  const track = async (req: () => Promise<Ticket>): Promise<Ticket> => {
    const my = nextSeq()
    setSyncing((n) => n + 1)
    try {
      const tk = await req()
      applyIf(my, tk)
      return tk
    } finally {
      setSyncing((n) => n - 1)
    }
  }

  const patchFile = (clientId: string, patch: Partial<LocalFile>) => setFiles((fs) => fs.map((f) => (f.clientId === clientId ? { ...f, ...patch } : f)))

  // Upload one file to its presigned URL, then tell the API it's done (with the page count).
  const sendOne = async (lf: LocalFile, target: UploadTarget, j: { id: string; secret: string }) => {
    patchFile(lf.clientId, { fileId: target.fileId, status: 'uploading' })
    try {
      await uploadFile(
        lf.file,
        target,
        (p) => patchFile(lf.clientId, { progress: p }),
        (w) => patchFile(lf.clientId, { status: w ? 'waiting' : 'uploading' }),
      )
      await track(() => api<Ticket>(`/jobs/${j.id}/files/${target.fileId}/complete`, { body: { pages: lf.pages }, secret: j.secret }))
      patchFile(lf.clientId, { status: 'done', progress: 1 })
    } catch (e) {
      patchFile(lf.clientId, {
        status: 'error',
        error: e instanceof ApiError ? e.message : t('uploadFailed'),
      })
    }
  }

  const onPick = async (list: FileList | null) => {
    if (!list || !shop) return
    setError('')
    const picked = Array.from(list)
    const existing = files.filter((f) => f.status !== 'locked' && f.status !== 'error')
    if (existing.length + picked.length > MAX_FILES) {
      setError(`Up to ${MAX_FILES} files per job.`)
      return
    }
    const fresh: LocalFile[] = []
    for (const file of picked) {
      const mime = mimeOf(file)
      if (!ALLOWED_MIMES.has(mime)) {
        setError(t('fileNotSupported', { name: file.name }))
        continue
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        setError(`${file.name} is ${bytes(file.size)}. The limit is ${MAX_FILE_MB} MB.`)
        continue
      }
      fresh.push({
        clientId: nextId(),
        file,
        mime,
        pages: fileKind(mime) === 'image' ? 1 : 0,
        status: 'checking',
        progress: 0,
        pageRange: '',
        other: false,
        note: '',
      })
    }
    const total = [...existing, ...fresh].reduce((s, f) => s + f.file.size, 0)
    if (total > MAX_JOB_MB * 1024 * 1024) {
      setError(`Files must add up to under ${MAX_JOB_MB} MB.`)
      return
    }
    if (fresh.length === 0) return
    setFiles((fs) => [...fs, ...fresh])

    // Count PDF pages on the phone; locked PDFs are stopped here.
    await Promise.all(
      fresh.map(async (lf) => {
        if (lf.mime !== 'application/pdf') return
        const r = await checkPdf(lf.file)
        lf.pages = r.pages
        if (r.locked) {
          lf.status = 'locked'
          patchFile(lf.clientId, { status: 'locked', error: t('locked') })
        } else patchFile(lf.clientId, { pages: r.pages })
      }),
    )
    const toSend = fresh.filter((f) => f.status !== 'locked')
    if (toSend.length === 0) return
    const meta = toSend.map((f) => ({
      clientId: f.clientId,
      filename: f.file.name,
      size: f.file.size,
      mime: f.mime,
    }))

    try {
      let j = jobRef.current
      let uploads: UploadTarget[]
      if (!j) {
        const my = nextSeq()
        const res = await api<{
          ticket: Ticket
          secret: string
          uploads: UploadTarget[]
        }>(`/shops/${slug}/jobs`, { body: { files: meta } })
        j = { id: res.ticket.job.id, secret: res.secret }
        setJob(j)
        applyIf(my, res.ticket)
        uploads = res.uploads
        if (settings.colour || settings.bothSides || settings.copies !== 1) {
          const jj = j
          track(() => api<Ticket>(`/jobs/${jj.id}`, { method: 'PATCH', body: { applyToAll: settings }, secret: jj.secret })).catch(() => {})
        }
      } else {
        const my = nextSeq()
        const res = await api<{ ticket: Ticket; uploads: UploadTarget[] }>(`/jobs/${j.id}/files`, { body: { files: meta }, secret: j.secret })
        applyIf(my, res.ticket)
        uploads = res.uploads
      }
      const byClient = new Map(uploads.map((u) => [u.clientId, u]))
      // At most 3 uploads at a time.
      const queue = toSend.slice()
      const jobNow = j
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let lf = queue.shift(); lf; lf = queue.shift()) {
            const target = byClient.get(lf.clientId)
            if (target) await sendOne(lf, target, jobNow)
          }
        }),
      )
      // One final read so the price shown is exactly what the server will charge.
      await track(() => api<Ticket>(`/jobs/${jobNow.id}`, { secret: jobNow.secret })).catch(() => {})
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : t('uploadFailed')
      setError(msg)
      toSend.forEach((f) => patchFile(f.clientId, { status: 'error', error: msg }))
      if (e instanceof ApiError && (e.code === 'shop_paused' || e.code === 'shop_offline')) loadShop()
    }
  }

  const removeFile = async (lf: LocalFile) => {
    setFiles((fs) => fs.filter((f) => f.clientId !== lf.clientId))
    if (job && lf.fileId) {
      try {
        await track(() => api<Ticket>(`/jobs/${job.id}/files/${lf.fileId}`, { method: 'DELETE', secret: job.secret }))
      } catch {
        /* the draft expires anyway */
      }
    }
  }

  const retryFile = async (lf: LocalFile) => {
    if (!job) return
    await removeFile(lf)
    const dt = new DataTransfer()
    dt.items.add(lf.file)
    await onPick(dt.files)
  }

  const applySettings = async (next: FileSettings) => {
    setSettings(next)
    if (!job) return
    try {
      await track(() => api<Ticket>(`/jobs/${job.id}`, { method: 'PATCH', body: { applyToAll: next }, secret: job.secret }))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update settings')
    }
  }

  const setPageRange = async (lf: LocalFile, range: string) => {
    patchFile(lf.clientId, { pageRange: range })
    if (!job || !lf.fileId) return
    try {
      const fileId = lf.fileId
      await track(() => api<Ticket>(`/jobs/${job.id}`, { method: 'PATCH', body: { files: [{ fileId, settings: { ...settings, pageRange: range } }] }, secret: job.secret }))
      patchFile(lf.clientId, { error: undefined })
    } catch (e) {
      patchFile(lf.clientId, {
        error: e instanceof ApiError ? e.message : 'Invalid pages',
      })
    }
  }

  const setPurpose = async (lf: LocalFile, other: boolean, note: string) => {
    patchFile(lf.clientId, { other, note, error: undefined })
    if (!job || !lf.fileId) return
    const fileId = lf.fileId
    const st = other ? { copies: 1, colour: false, bothSides: false, other: true, note } : { ...settings, pageRange: lf.pageRange }
    try {
      await track(() => api<Ticket>(`/jobs/${job.id}`, { method: 'PATCH', body: { files: [{ fileId, settings: st }] }, secret: job.secret }))
    } catch (e) {
      patchFile(lf.clientId, { error: e instanceof ApiError ? e.message : 'Could not update' })
    }
  }

  const live = files.filter((f) => f.status !== 'locked' && f.status !== 'error')
  const allOther = live.length > 0 && live.every((f) => f.other)
  const allUploaded = live.length > 0 && live.every((f) => f.status === 'done')
  const quote = ticket?.quote

  const send = async () => {
    if (!job || !quote) return
    setSending(true)
    setError('')
    try {
      const tk = await api<Ticket>(`/jobs/${job.id}/submit`, {
        body: { priceVersion: quote.priceVersion, customerName: name.trim() },
        secret: job.secret,
      })
      saveTicket({
        jobId: job.id,
        secret: job.secret,
        slug,
        shopName: shop?.name ?? '',
        token: tk.job.token,
        createdAt: Date.now(),
      })
      // Push, not replace: Back from the ticket returns to a fresh drop page for this shop instead of
      // leaving the site (customers who opened it from the QR would otherwise have to scan again).
      navigate(`/t/${job.id}`)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'price_changed') {
        await track(() => api<Ticket>(`/jobs/${job.id}`, { secret: job.secret }))
      }
      setError(e instanceof ApiError ? e.message : 'Could not send. Try again.')
      setSending(false)
    }
  }

  if (shopError) {
    return (
      <Shell>
        <Card className="p-5 text-center">
          <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-attention" aria-hidden />
          <p className="font-medium">{shopError}</p>
        </Card>
      </Shell>
    )
  }
  if (!shop) {
    return (
      <Shell>
        <div className="flex justify-center py-16 text-ink-muted">
          <Spinner className="h-8 w-8" />
        </div>
      </Shell>
    )
  }

  const blocked = shop.onlineState !== 'online'
  const p = shop.prices

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!blocked && !sending && e.dataTransfer.files.length) onPick(e.dataTransfer.files)
  }
  const dragProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      if (!dragging) setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false)
    },
    onDrop,
  }

  const priceCard = (
    <Card className="p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">{t('price')}</h2>
      {quote?.lines.map((l) => {
        const f = files.find((x) => x.fileId === l.fileId)
        if (!f) return null
        if (l.other)
          return (
            <div key={l.fileId} className="flex justify-between gap-3 py-1 text-sm">
              <span className="truncate">
                {f.file.name} · {t('otherUse')}
              </span>
              <span className="shrink-0 text-ink-muted">{t('shopSets')}</span>
            </div>
          )
        return (
          <div key={l.fileId} className="flex justify-between gap-3 py-1 text-sm">
            <span className="truncate">
              {f.file.name} · {l.unit === 'sheet' ? `${l.sheets} × ${rupees(l.unitPaise)}` : `${l.sides} × ${rupees(l.unitPaise)}`}
              {l.copies > 1 ? ` × ${l.copies}` : ''}
            </span>
            <span className="font-mono tabular">{f.pages ? rupees(l.amountPaise) : '—'}</span>
          </div>
        )
      })}
      <div className="mt-2 flex items-end justify-between border-t border-divider pt-2">
        <div>
          <div className="font-mono text-2xl font-bold tabular">{quote ? rupees(quote.totalPaise) + (quote.otherFiles > 0 ? ' +' : '') : '—'}</div>
          {quote && quote.otherFiles > 0 && <div className="text-sm font-semibold text-action">{t('plusOther')}</div>}
          <div className="text-xs text-ink-muted">{quote?.pagesToConfirm ? t('priceAtCounter') : t('payAtCounter')}</div>
        </div>
        <WaitChip shop={shop} />
      </div>
    </Card>
  )

  // Shop's rates, shown beside the drop zone on wide screens before any file is chosen.
  const ratesCard = (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">{t('price')}</h2>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt>
            {t('bw')} · {t('oneSide')}
          </dt>
          <dd className="font-mono tabular">{t('perSide', { p: rupees(p.bwOnePaise) })}</dd>
        </div>
        <div className="flex justify-between">
          <dt>
            {t('bw')} · {t('bothSides')}
          </dt>
          <dd className="font-mono tabular">{t('perSheet', { p: rupees(p.bwBothPaise || p.bwOnePaise * 2) })}</dd>
        </div>
        {shop.colourAvailable && (
          <>
            <div className="flex justify-between">
              <dt>
                {t('colour')} · {t('oneSide')}
              </dt>
              <dd className="font-mono tabular">{t('perSide', { p: rupees(p.colourOnePaise) })}</dd>
            </div>
            <div className="flex justify-between">
              <dt>
                {t('colour')} · {t('bothSides')}
              </dt>
              <dd className="font-mono tabular">
                {t('perSheet', {
                  p: rupees(p.colourBothPaise || p.colourOnePaise * 2),
                })}
              </dd>
            </div>
          </>
        )}
      </dl>
      <p className="mt-3 border-t border-divider pt-3 text-xs text-ink-muted">{t('payAtCounter')}</p>
    </Card>
  )

  const privacy = (
    <p className="flex gap-2 rounded bg-surface-tint p-3 text-sm text-ink-muted">
      <ShieldCheck className="h-5 w-5 shrink-0 text-ready" aria-hidden /> {t('privacy')}
    </p>
  )

  if (blocked) {
    return (
      <Shell shop={shop}>
        <Card className="p-5 text-center">
          <Clock className="mx-auto mb-2 h-8 w-8 text-attention" aria-hidden />
          <p className="text-lg font-semibold">{shop.onlineState === 'paused' ? t('shopPaused') : t('shopOffline')}</p>
          {shop.pauseMessage && <p className="mt-1 text-ink-muted">{shop.pauseMessage}</p>}
          <Button variant="secondary" className="mt-4" onClick={loadShop}>
            <RotateCw className="h-4 w-4" aria-hidden /> {t('checkAgain')}
          </Button>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell shop={shop} wide>
      {openTicket && (
        <Banner
          action={
            <Link className="font-semibold text-action underline" to={`/t/${openTicket.jobId}`}>
              {t('view')}
            </Link>
          }
        >
          {t('haveTicket', { token: openTicket.token ?? '' })}
        </Banner>
      )}
      {!shop.isOpen && <Banner tone="attention">{t('shopClosed', { time: hhmm(shop.opensAt) })}</Banner>}
      <input ref={inputRef} type="file" multiple accept={ACCEPTED} className="hidden" onChange={(e) => onPick(e.target.files).finally(() => (e.target.value = ''))} />

      <div className="space-y-3 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6 lg:space-y-0">
        {/* Left: files and settings */}
        <div className="space-y-3" {...dragProps}>
          {files.length === 0 ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={`flex w-full flex-col items-center gap-2 rounded border-2 border-dashed px-4 py-10 text-center hover:bg-surface-tint lg:py-24 ${dragging ? 'border-action bg-surface-tint' : 'border-action bg-surface'}`}
            >
              <span className="flex h-14 w-14 items-center justify-center rounded bg-surface-tint text-action lg:h-20 lg:w-20">
                <Plus className="h-8 w-8 lg:h-10 lg:w-10" aria-hidden />
              </span>
              <span className="text-xl font-bold lg:text-2xl">{t('chooseFiles')}</span>
              <span className="hidden text-ink-muted lg:block">{t('dragHint')}</span>
              <span className="text-sm text-ink-muted">{t('fileTypes', { n: MAX_FILES, mb: MAX_JOB_MB })}</span>
            </button>
          ) : (
            <div className={`space-y-2 rounded ${dragging ? 'outline-dashed outline-2 outline-offset-4 outline-action' : ''}`}>
              {files.map((lf) => (
                <FileRow
                  key={lf.clientId}
                  lf={lf}
                  quote={quote?.lines.find((l) => l.fileId === lf.fileId)}
                  onRemove={() => removeFile(lf)}
                  onRetry={() => retryFile(lf)}
                  onRange={(r) => setPageRange(lf, r)}
                  onPurpose={(other, note) => setPurpose(lf, other, note)}
                />
              ))}
              <Button variant="secondary" className="w-full" onClick={() => inputRef.current?.click()} disabled={sending}>
                <Plus className="h-5 w-5" aria-hidden /> {t('addMore')}
                <span className="hidden font-normal text-ink-muted lg:inline">· {t('dragHint')}</span>
              </Button>
            </div>
          )}

          {error && <Banner tone="danger">{error}</Banner>}

          {files.length > 0 && !allOther && (
            <Card className="space-y-4 p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-bold">{t('settings')}</h2>
                <span className="text-sm text-ink-muted">{t('forAllFiles')}</span>
              </div>
              <div className="space-y-4 xl:grid xl:grid-cols-2 xl:gap-4 xl:space-y-0">
                <Segmented
                  label={t('colour')}
                  value={settings.colour}
                  onChange={(v) => applySettings({ ...settings, colour: v })}
                  options={[
                    {
                      value: false,
                      label: t('bw'),
                      hint: t('perSide', { p: rupees(p.bwOnePaise) }),
                    },
                    {
                      value: true,
                      label: t('colour'),
                      hint: shop.colourAvailable ? t('perSide', { p: rupees(p.colourOnePaise) }) : '—',
                      disabled: !shop.colourAvailable,
                    },
                  ]}
                />
                <Segmented
                  label={t('bothSides')}
                  value={settings.bothSides}
                  onChange={(v) => applySettings({ ...settings, bothSides: v })}
                  options={[
                    { value: false, label: t('oneSide') },
                    {
                      value: true,
                      label: t('bothSides'),
                      hint: t('perSheet', {
                        p: rupees(settings.colour ? p.colourBothPaise || p.colourOnePaise * 2 : p.bwBothPaise || p.bwOnePaise * 2),
                      }),
                    },
                  ]}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="font-semibold">{t('copies')}</span>
                <Stepper label={t('copies')} value={settings.copies} onChange={(c) => applySettings({ ...settings, copies: c })} />
              </div>
            </Card>
          )}

          <div className="lg:hidden">{files.length === 0 && privacy}</div>
          {files.length === 0 && shop.orders.enabled && shop.orders.services.length > 0 && (
            <Link to={`/s/${slug}/order`} className="flex items-center gap-3 rounded border-[1.5px] border-line bg-surface p-4 hover:border-action">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-ink text-[#E8C872]">
                <BookOpen className="h-6 w-6" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{t('bbEntryTitle')}</span>
                <span className="block text-sm text-ink-muted">{t('bbEntryText')}</span>
              </span>
              <span className="hidden shrink-0 font-semibold text-action sm:block">{t('bbEntryCta')} →</span>
            </Link>
          )}
          {files.length === 0 && <InstallCard compact />}
        </div>

        {/* Right (desktop) / below (phone): name, price and send */}
        <aside className="space-y-3 lg:sticky lg:top-24">
          {files.length === 0 ? (
            <div className="hidden space-y-3 lg:block">
              {ratesCard}
              {privacy}
            </div>
          ) : (
            <>
              <Card className="p-4">
                <label htmlFor="name" className="block font-semibold">
                  {t('firstName')}
                </label>
                <input
                  id="name"
                  value={name}
                  maxLength={20}
                  autoComplete="given-name"
                  onChange={(e) => setName(e.target.value)}
                  className="mt-2 h-12 w-full rounded border-[1.5px] border-line bg-surface px-3 text-base focus:border-action focus:outline-none"
                  placeholder="Priya"
                />
                <p className="mt-1 text-xs text-ink-muted">{t('firstNameHint')}</p>
              </Card>
              {priceCard}
              {privacy}
              <div className="sticky bottom-0 -mx-4 grid grid-cols-[auto,minmax(0,1fr)] gap-2 border-t border-line bg-canvas px-4 py-3 lg:static lg:mx-0 lg:block lg:border-0 lg:bg-transparent lg:p-0">
                <Button variant="secondary" size="lg" className="px-3 lg:mb-2 lg:w-full" onClick={() => inputRef.current?.click()} disabled={sending}>
                  <Plus className="h-5 w-5" aria-hidden />
                  <span className="hidden sm:inline">{t('addMore')}</span>
                </Button>
                <Button size="lg" className="w-full" onClick={send} disabled={!allUploaded || sending || !quote || syncing > 0}>
                  {sending ? <Spinner /> : null}
                  {sending ? t('sending') : !allUploaded ? t('uploading') : t('send')}
                  {quote && allUploaded && !sending ? <span className="ml-auto rounded bg-white/15 px-2 font-mono text-sm">{rupees(quote.totalPaise)}{quote.otherFiles > 0 ? ' +' : ''}</span> : null}
                </Button>
              </div>
            </>
          )}
        </aside>
      </div>
    </Shell>
  )
}

function WaitChip({ shop }: { shop: PublicShop }) {
  const { t } = useI18n()
  if (shop.wait.jobsAhead === 0) return <Chip tone="ready">{t('noWait')}</Chip>
  return (
    <Chip>
      {t(shop.wait.jobsAhead === 1 ? 'jobAhead1' : 'jobsAhead', {
        n: shop.wait.jobsAhead,
        low: shop.wait.lowMinutes,
        high: shop.wait.highMinutes,
      })}
    </Chip>
  )
}

function FileRow({
  lf,
  quote,
  onRemove,
  onRetry,
  onRange,
  onPurpose,
}: {
  lf: LocalFile
  quote?: { amountPaise: number }
  onRemove: () => void
  onRetry: () => void
  onRange: (r: string) => void
  onPurpose: (other: boolean, note: string) => void
}) {
  const { t } = useI18n()
  const [note, setNote] = useState(lf.note)
  const [editRange, setEditRange] = useState(false)
  const [range, setRange] = useState(lf.pageRange)
  const kind = fileKind(lf.mime)
  const Icon = kind === 'image' ? ImageIcon : kind === 'document' ? FileType : FileText
  const bad = lf.status === 'error' || lf.status === 'locked'
  return (
    <div className={`rounded border-[1.5px] bg-surface p-3 ${bad ? 'border-danger' : 'border-line'}`}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-tint text-action">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{lf.file.name}</div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
            {lf.status === 'checking' ? (
              t('counting')
            ) : lf.pages > 0 ? (
              <Chip>{lf.pages === 1 ? t('page') : t('pages', { n: lf.pages })}</Chip>
            ) : lf.status !== 'locked' ? (
              <Chip tone="attention">{t('pagesUnknown')}</Chip>
            ) : null}
            {lf.pageRange && <Chip tone="action">{lf.pageRange}</Chip>}
            <span>{bytes(lf.file.size)}</span>
          </div>
        </div>
        <div className="text-right">
          {lf.status === 'done' && lf.other && <div className="text-xs font-semibold text-ink-muted">{t('shopSets')}</div>}
          {lf.status === 'done' && !lf.other && quote && lf.pages > 0 && <div className="font-mono font-bold tabular">{rupees(quote.amountPaise)}</div>}
          <button type="button" onClick={onRemove} className="p-2 text-ink-muted hover:text-danger" aria-label={`${t('remove')} ${lf.file.name}`}>
            <Trash2 className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
      {(lf.status === 'uploading' || lf.status === 'waiting') && (
        <div className="mt-2">
          <div className="h-1 overflow-hidden rounded bg-divider">
            <div className="h-full bg-action transition-all" style={{ width: `${Math.round(lf.progress * 100)}%` }} />
          </div>
          {lf.status === 'waiting' && (
            <p className="mt-1 flex items-center gap-1 text-xs text-attention">
              <WifiOff className="h-3 w-3" aria-hidden /> {t('waitingNetwork')}
            </p>
          )}
        </div>
      )}
      {bad && (
        <p className="mt-2 flex items-center justify-between gap-2 text-sm text-danger">
          <span>{lf.error}</span>
          {lf.status === 'error' && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t('retry')}
            </Button>
          )}
        </p>
      )}
      {lf.status === 'done' && (
        <div className="mt-2 space-y-2">
          <div role="radiogroup" aria-label={t('otherNoteLabel')} className="grid grid-cols-2 gap-2">
            {[false, true].map((o) => (
              <button
                key={String(o)}
                type="button"
                role="radio"
                aria-checked={lf.other === o}
                onClick={() => lf.other !== o && onPurpose(o, note)}
                className={`min-h-[44px] rounded px-3 text-sm font-semibold ${lf.other === o ? 'border-2 border-action bg-surface-tint text-ink' : 'border-[1.5px] border-line bg-surface text-ink-muted'}`}
              >
                {o ? t('otherUse') : t('printIt')}
              </button>
            ))}
          </div>
          {lf.other && (
            <label className="block text-sm">
              <span className="font-semibold">{t('otherNoteLabel')}</span>
              <input
                value={note}
                maxLength={140}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => note !== lf.note && onPurpose(true, note)}
                placeholder={t('otherNotePh')}
                className="mt-1 h-11 w-full rounded border-[1.5px] border-line bg-surface px-2 text-base focus:border-action focus:outline-none"
              />
            </label>
          )}
          {lf.other && lf.error && !bad && <p className="text-sm text-danger">{lf.error}</p>}
        </div>
      )}
      {lf.status === 'done' && !lf.other && kind === 'document' && <p className="mt-2 text-xs text-ink-muted">{t('docPagesNote')}</p>}
      {lf.status === 'done' && !lf.other && lf.mime === 'application/pdf' && lf.pages > 1 && (
        <div className="mt-2 text-sm">
          {editRange ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                onRange(range.trim())
                setEditRange(false)
              }}
            >
              <input
                value={range}
                onChange={(e) => setRange(e.target.value)}
                inputMode="numeric"
                placeholder={t('pageRangeHint')}
                className="h-10 flex-1 rounded border-[1.5px] border-line bg-surface px-2"
                aria-label={t('pageRange')}
              />
              <Button size="sm" type="submit">
                OK
              </Button>
            </form>
          ) : (
            <button type="button" className="font-semibold text-action" onClick={() => setEditRange(true)}>
              {t('pageRange')}: {lf.pageRange || t('allPages')}
            </button>
          )}
          {lf.error && !bad && <p className="text-danger">{lf.error}</p>}
        </div>
      )}
    </div>
  )
}

export function Shell({ shop, children, wide = false }: { shop?: PublicShop; children: React.ReactNode; wide?: boolean }) {
  const { t } = useI18n()
  const width = wide ? 'max-w-lg lg:max-w-6xl' : 'max-w-lg'
  const status = shop && (
    <>
      {shop.onlineState === 'online' ? (
        <Chip tone={shop.isOpen ? 'ready' : 'attention'}>{shop.isOpen ? t('open', { time: hhmm(shop.closesAt) }) : t('closed', { time: hhmm(shop.opensAt) })}</Chip>
      ) : (
        <Chip tone="attention">{t('paused')}</Chip>
      )}
      {shop.onlineState === 'online' && <WaitChip shop={shop} />}
    </>
  )
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-surface">
        <div className={`mx-auto w-full px-4 py-3 lg:py-4 ${width}`}>
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-bold leading-tight lg:text-xl">{shop?.name ?? 'Counter Drop'}</div>
              <div className="truncate text-xs text-ink-muted lg:text-sm">{shop ? shop.address || t('tagline') : t('tagline')}</div>
            </div>
            {shop && <div className="hidden flex-wrap items-center gap-2 lg:flex">{status}</div>}
            <LangSwitch />
          </div>
          {shop && <div className="mt-2 flex flex-wrap gap-2 lg:hidden">{status}</div>}
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 space-y-3 px-4 py-4 lg:space-y-4 lg:py-8 ${width}`}>{children}</main>
      <footer className="pb-24 pt-2 lg:pb-6">
        <LegalLinks />
      </footer>
    </div>
  )
}
