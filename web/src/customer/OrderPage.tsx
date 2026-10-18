import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { Check, CheckCircle2, Download, FileText, Lock, Pencil, Plus, Share2, ShieldCheck, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useI18n, type Key } from '@/lib/i18n'
import { useLive, type LiveTicket } from '@/lib/live'
import { clock, rupees } from '@/lib/format'
import { uploadFile, mimeOf, ACCEPTED, ALLOWED_MIMES } from '@/lib/upload'
import { checkPdf } from '@/lib/pdf'
import { dateLabel, dueLabel, findOrder, saveOrder, stageIndex } from '@/lib/orders'
import { canDeleteFiles, proofLocked, serviceOf } from '@/lib/services'
import { ServiceIcon } from '@/components/ServiceIcon'
import type { CoverText, Order, OrderView, UploadTarget } from '@/lib/types'
import { Banner, Button, Card, Chip, Spinner } from '@/components/ui'
import { Shell } from './DropPage'

const input = 'mt-1 h-11 w-full rounded border-[1.5px] border-line bg-surface px-3 text-base focus:border-action focus:outline-none'

const STEPS: { state: Order['state']; key: Key }[] = [
  { state: 'requested', key: 'ev_sent' },
  { state: 'quoted', key: 'ev_quoted' },
  { state: 'confirmed', key: 'ev_confirmed' },
  { state: 'printing', key: 'oState_printing' },
  { state: 'binding', key: 'oState_binding' },
  { state: 'ready', key: 'oState_ready' },
  { state: 'delivered', key: 'oState_delivered' },
]

const COVER_FIELDS: { k: keyof CoverText; label: Key }[] = [
  { k: 'title', label: 'cTitle' },
  { k: 'student', label: 'cStudent' },
  { k: 'rollNo', label: 'cRoll' },
  { k: 'course', label: 'cCourse' },
  { k: 'college', label: 'cCollege' },
  { k: 'guide', label: 'cGuide' },
  { k: 'year', label: 'cYear' },
  { k: 'spine', label: 'cSpine' },
  { k: 'extra', label: 'cExtra' },
]

/** /o/:orderId — the customer's order page (blackbook, binding, cards…). */
export default function OrderPage() {
  const { orderId = '' } = useParams()
  const location = useLocation()
  const { t } = useI18n()
  const [secret] = useState(() => location.hash.replace(/^#/, '') || findOrder(orderId)?.secret || '')
  const [view, setView] = useState<OrderView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editCover, setEditCover] = useState<CoverText | null>(null)
  const [notice, setNotice] = useState('')
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null)
  const pick = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (location.hash) window.history.replaceState(null, '', location.pathname)
  }, [location])

  const load = useCallback(async () => {
    if (!secret) return
    try {
      const v = await api<OrderView>(`/orders/${orderId}`, { secret })
      setView(v)
      setError('')
      saveOrder({ orderId, secret, slug: v.shop.slug, shopName: v.shop.name, code: v.order.code, savedAt: findOrder(orderId)?.savedAt ?? Date.now() })
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 401 || e.status === 403 ? t('oLinkLost') : e.message) : 'Could not load')
    }
  }, [orderId, secret, t])

  useEffect(() => {
    load()
  }, [load])
  useLive(
    secret ? { sse: `/orders/${orderId}/events?secret=${encodeURIComponent(secret)}`, ticket: () => api<LiveTicket>(`/orders/${orderId}/live`, { method: 'POST', secret }) } : null,
    () => load(),
    load,
    30000,
  )

  const run = async (fn: () => Promise<OrderView>) => {
    setBusy(true)
    setError('')
    try {
      setView(await fn())
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (!secret) {
    return (
      <Shell>
        <Card className="p-5 text-center">{t('oLinkLost')}</Card>
      </Shell>
    )
  }
  if (!view) {
    return <Shell>{error ? <Banner tone="danger">{error}</Banner> : <div className="flex justify-center py-16"><Spinner className="h-8 w-8" /></div>}</Shell>
  }

  const { order: o, shop } = view
  const open = o.state !== 'delivered' && o.state !== 'cancelled'
  const idx = stageIndex(o.state)
  const svc = serviceOf(o.kind)
  const isText = svc.proof === 'text'
  const coverEditable = open && o.state !== 'ready' && !proofLocked(svc, o.state)
  const hasProof = svc.proof !== '' && (isText ? !!o.cover.text : !!o.cover.title)
  const bindKey: Record<string, Key> = { hard: 'bindHard', spiral: 'bindSpiral', soft: 'bindSoft', none: 'bindNone' }
  const what =
    svc.form === 'document'
      ? [`${o.spec.copies ?? 1} ${t('bbCopies').toLowerCase()}`, o.spec.binding ? t(bindKey[o.spec.binding] ?? 'bindNone') : '', o.spec.pages ? t('pages', { n: o.spec.pages }) : ''].filter(Boolean).join(' · ')
      : svc.form === 'quantity'
        ? [`${o.spec.quantity ?? 0} ${svc.unit ? t(`unit_${svc.unit}` as Key) : ''}`, o.spec.size ?? ''].filter(Boolean).join(' · ')
        : (o.spec.description ?? '')
  const canCancel = (o.state === 'requested' || o.state === 'quoted' || o.state === 'draft') && o.paidPaise === 0
  const liveFiles = o.files.filter((f) => !f.deletedAt)
  const keptUntil = liveFiles.map((f) => f.deleteAfter).filter(Boolean).sort()[0]
  const status = t(`oState_${o.state}` as Key)

  const share = async () => {
    const url = `${window.location.origin}/o/${o.id}`
    const text = t('oShareText', { code: o.code, shop: shop.name, status, url })
    try {
      if (navigator.share) await navigator.share({ text })
      else {
        await navigator.clipboard.writeText(text)
        setNotice(t('shareCopied'))
      }
    } catch {
      /* closed */
    }
  }

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    const file = list[0]!
    const mime = mimeOf(file)
    if (!ALLOWED_MIMES.has(mime)) {
      setError(t('fileNotSupported', { name: file.name }))
      return
    }
    setBusy(true)
    setError('')
    try {
      const pages = mime === 'application/pdf' ? (await checkPdf(file)).pages : 0
      const res = await api<{ view: OrderView; uploads: UploadTarget[] }>(`/orders/${o.id}/files`, { body: { files: [{ clientId: 'x', filename: file.name, size: file.size, mime }] }, secret })
      const target = res.uploads[0]
      if (target) {
        setUpload({ name: file.name, progress: 0 })
        await uploadFile(file, target, (p) => setUpload({ name: file.name, progress: p }), () => {})
        setView(await api<OrderView>(`/orders/${o.id}/files/${target.fileId}/complete`, { body: { pages }, secret }))
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('uploadFailed'))
    } finally {
      setUpload(null)
      setBusy(false)
    }
  }

  return (
    <Shell shop={shop}>
      {notice && <Banner tone="ready">{notice}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}

      {/* Status */}
      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
              <ServiceIcon id={o.kind} className="h-4 w-4" /> {t(`svc_${svc.id}` as Key)}
            </div>
            <div className="font-mono text-3xl font-bold">{o.code}</div>
            <div className="text-xs text-ink-muted">{t('oShowCode')}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={share} aria-label={t('oShare')}>
            <Share2 className="h-5 w-5" aria-hidden />
          </Button>
        </div>
        <div className={`rounded p-3 font-semibold ${o.state === 'ready' ? 'bg-ready-bg text-ready' : o.state === 'cancelled' ? 'bg-danger-bg text-danger' : o.state === 'quoted' ? 'bg-attention-bg text-attention' : 'bg-surface-tint'}`}>
          {status}
          {o.state === 'cancelled' && o.cancelReason && o.cancelReason !== 'customer_cancelled' ? ` · ${o.cancelReason}` : ''}
        </div>
        {o.state !== 'cancelled' && (
          <ol className="grid grid-cols-7 gap-1" aria-label={t('oHistory')}>
            {STEPS.map((s, i) => (
              <li key={s.state} className="space-y-1" title={t(s.key)}>
                <div className={`h-1.5 rounded ${i <= idx ? 'bg-action' : 'bg-divider'}`} />
              </li>
            ))}
          </ol>
        )}
        {what && <div className="whitespace-pre-line text-sm text-ink-muted">{what}</div>}
        {open && <div className="text-sm">{t('oDue', { date: dueLabel(o.dueDate) })}</div>}
      </Card>

      {/* Money */}
      <Card className="space-y-2 p-4">
        {o.lines.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('oPriceSoon')}</p>
        ) : (
          <>
            {o.lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-3 text-sm">
                <span>{l.label}</span>
                <span className="font-mono tabular">{rupees(l.paise)}</span>
              </div>
            ))}
            <div className="space-y-1 border-t border-divider pt-2">
              <div className="flex justify-between font-bold">
                <span>{t('oTotal')}</span>
                <span className="font-mono tabular">{rupees(o.totalPaise)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>{t('oPaid')}</span>
                <span className="font-mono tabular">{rupees(o.paidPaise)}</span>
              </div>
              <div className="flex justify-between text-lg font-bold">
                <span>{t('oBalance')}</span>
                <span className="font-mono tabular">{rupees(view.balancePaise)}</span>
              </div>
            </div>
            {o.state === 'quoted' && o.advancePaise > 0 && <Banner tone="attention">{t('oAdvance', { p: rupees(o.advancePaise) })}</Banner>}
            {o.payments.length > 0 && (
              <div className="border-t border-divider pt-2">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('oPayments')}</div>
                {o.payments.map((p) => (
                  <div key={p.id} className="flex justify-between text-sm">
                    <span>
                      {t(`pay_${p.kind}` as Key)} · {p.method.toUpperCase()} · {dateLabel(p.at)}
                    </span>
                    <span className="font-mono tabular">{rupees(p.paise)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {/* Cover approval */}
      {(hasProof || editCover) && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{isText ? t('oTextCheck') : t('oCoverCheck')}</h2>
            {o.coverApprovedAt && !editCover && (
              <Chip tone="ready">
                <Check className="h-3 w-3" aria-hidden /> OK
              </Chip>
            )}
          </div>
          {editCover ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault()
                run(() => api<OrderView>(`/orders/${o.id}/cover`, { method: 'PUT', body: editCover, secret })).then(() => setEditCover(null))
              }}
            >
              {isText ? (
                <label className="block text-sm">
                  <span className="font-semibold">{t('textLabel')}</span>
                  <textarea className={`${input} h-32 py-2 font-mono text-sm`} value={editCover.text ?? ''} maxLength={1000} onChange={(e) => setEditCover({ ...editCover, text: e.target.value })} />
                </label>
              ) : (
                COVER_FIELDS.map((f) => (
                  <label key={f.k} className="block text-sm">
                    <span className="font-semibold">{t(f.label)}</span>
                    <input className={input} value={editCover[f.k] ?? ''} onChange={(e) => setEditCover({ ...editCover, [f.k]: e.target.value })} />
                  </label>
                ))
              )}
              <div className="flex gap-2">
                <Button type="button" variant="secondary" className="flex-1" onClick={() => setEditCover(null)}>
                  {t('oBack')}
                </Button>
                <Button type="submit" className="flex-1" disabled={busy}>
                  {isText ? t('oTextSave') : t('oCoverSave')}
                </Button>
              </div>
            </form>
          ) : (
            <>
              {isText ? (
                <pre className="whitespace-pre-wrap rounded border-[1.5px] border-line bg-surface p-4 text-center font-sans text-base font-semibold">{o.cover.text}</pre>
              ) : (
              <div className="rounded bg-ink p-4 text-center text-[#E8C872]">
                <div className="text-lg font-bold uppercase leading-snug">{o.cover.title}</div>
                {o.cover.course && <div className="mt-2 text-sm">{o.cover.course}</div>}
                <div className="mt-3 text-sm">
                  {o.cover.student}
                  {o.cover.rollNo ? ` · ${o.cover.rollNo}` : ''}
                </div>
                {o.cover.guide && <div className="text-xs">{o.cover.guide}</div>}
                <div className="mt-3 text-sm font-semibold">{o.cover.college}</div>
                {o.cover.year && <div className="text-xs">{o.cover.year}</div>}
                {o.cover.extra && <div className="mt-2 text-xs">{o.cover.extra}</div>}
              </div>
              )}
              {o.cover.spine && (
                <div className="text-sm">
                  <span className="text-ink-muted">{t('cSpine')}: </span>
                  <b>{o.cover.spine}</b>
                </div>
              )}
              {o.coverApprovedAt ? (
                <p className="flex items-center gap-1 text-sm text-ready">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('oCoverApproved', { date: dateLabel(o.coverApprovedAt) })}
                </p>
              ) : open ? (
                <p className="text-sm text-ink-muted">{isText ? t('oTextWhy') : t('oCoverWhy')}</p>
              ) : null}
              {coverEditable ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" onClick={() => setEditCover({ ...o.cover })} disabled={busy}>
                    <Pencil className="h-4 w-4" aria-hidden /> {t('oCoverEdit')}
                  </Button>
                  {!o.coverApprovedAt && (
                    <Button variant="ready" onClick={() => run(() => api<OrderView>(`/orders/${o.id}/approve-cover`, { body: { version: o.coverVersion }, secret }))} disabled={busy}>
                      <Check className="h-4 w-4" aria-hidden /> {t('oCoverApprove')}
                    </Button>
                  )}
                </div>
              ) : (
                open && (
                  <p className="flex items-center gap-1 text-sm text-ink-muted">
                    <Lock className="h-4 w-4" aria-hidden /> {t('oCoverLocked')}
                  </p>
                )
              )}
            </>
          )}
        </Card>
      )}

      {/* Files */}
      <Card className="space-y-2 p-4">
        <h2 className="font-semibold">{t('yourFiles')}</h2>
        <input ref={pick} type="file" accept={ACCEPTED} className="hidden" onChange={(e) => addFiles(e.target.files).finally(() => (e.target.value = ''))} />
        {o.files.map((f, i) => (
          <div key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-ink-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{f.filename || t('rFileN', { n: i + 1 })}</span>
            {f.deletedAt ? (
              <Chip tone="ready">{t('ev_files_deleted')}</Chip>
            ) : f.downloads > 0 ? (
              <Chip tone="attention">
                <Download className="h-3 w-3" aria-hidden /> {t('oDownloadedBy', { name: f.downloadedBy ?? '' })} · {clock(f.downloadedAt)}
              </Chip>
            ) : null}
          </div>
        ))}
        {upload && (
          <div className="h-1 overflow-hidden rounded bg-divider">
            <div className="h-full bg-action transition-all" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
          </div>
        )}
        {liveFiles.length > 0 && open && !canDeleteFiles(o.state) && <p className="text-xs text-ink-muted">{t('oFilesInUse')}</p>}
        {o.filesDeletedAt ? (
          <p className="flex items-center gap-1 text-sm text-ready">
            <ShieldCheck className="h-4 w-4" aria-hidden /> {t('oFilesDeleted', { date: dateLabel(o.filesDeletedAt) })}
          </p>
        ) : (
          keptUntil && <p className="text-xs text-ink-muted">{t('oKeptUntil', { date: dateLabel(keptUntil) })}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {open && o.state !== 'ready' && (
            <Button variant="secondary" size="sm" onClick={() => pick.current?.click()} disabled={busy}>
              <Plus className="h-4 w-4" aria-hidden /> {t('oAddFile')}
            </Button>
          )}
          {liveFiles.length > 0 && canDeleteFiles(o.state) && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => window.confirm(t('oDeleteConfirm')) && run(() => api<OrderView>(`/orders/${o.id}/delete-files`, { body: {}, secret }))}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> {t('oDeleteFiles')}
            </Button>
          )}
        </div>
      </Card>

      {/* History */}
      <Card className="p-4">
        <h2 className="mb-2 font-semibold">{t('oHistory')}</h2>
        <ol className="space-y-1.5 text-sm">
          {[...o.history].reverse().map((h, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>{t(`ev_${h.action}` as Key) || h.action}</span>
              <span className="shrink-0 text-ink-muted">
                {dateLabel(h.at)} {clock(h.at)}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <p className="text-center text-xs text-ink-muted">{t('oBookmark')}</p>
      {canCancel && (
        <Button variant="ghost" className="w-full text-danger" disabled={busy} onClick={() => window.confirm(t('oCancelConfirm')) && run(() => api<OrderView>(`/orders/${o.id}/cancel`, { body: {}, secret }))}>
          {t('oCancel')}
        </Button>
      )}
    </Shell>
  )
}
