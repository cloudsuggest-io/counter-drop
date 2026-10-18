import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronRight, FileText, FileType, Plus, ShieldCheck, Trash2, WifiOff } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useI18n, type Key } from '@/lib/i18n'
import { bytes, rupees } from '@/lib/format'
import { checkPdf } from '@/lib/pdf'
import { uploadFile, mimeOf, fileKind, ACCEPTED, ALLOWED_MIMES } from '@/lib/upload'
import { addDays, saveOrder, todayIST } from '@/lib/orders'
import { clearOrderDraft, loadOrderDraft, saveOrderDraft } from '@/lib/orderDraft'
import { quantityEstimate, serviceOf, SERVICES, type ServiceDef } from '@/lib/services'
import type { Binding, CoverText, OrderSpec, OrderView, PublicShop, ServiceSetting, UploadTarget } from '@/lib/types'
import { Banner, Button, Card, Segmented, Spinner, Stepper } from '@/components/ui'
import { ServiceIcon } from '@/components/ServiceIcon'
import { Shell } from './DropPage'

const MAX_FILE_MB = 500

interface PickedFile {
  id: string
  file: File
  mime: string
  pages: number
  progress: number
  status: 'ready' | 'uploading' | 'waiting' | 'done' | 'error'
}

interface StoredOrderDraft {
  files: { id: string; file: File; pages: number }[]
  copies: number
  binding: Binding
  colourPages: string
  pages: string
  quantity: string
  size: string
  description: string
  cover: CoverText
  text: string
  notes: string
  due: string
  name: string
  phone: string
  consent: boolean
}

const input = 'mt-1 h-12 w-full rounded border-[1.5px] border-line bg-surface px-3 text-base focus:border-action focus:outline-none'

function Field({ label, hint, required = false, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}{required && <span className="ml-1 text-danger" aria-hidden="true">*</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  )
}

let n = 0

/**
 * /s/:slug/order — what the customer can order from this shop (blackbook, binding, cards…), and
 * /s/:slug/order/:service — the form for one service.
 */
export default function OrderRequestPage() {
  const { slug = '', service: serviceId } = useParams()
  const { t } = useI18n()
  const [shop, setShop] = useState<PublicShop | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    api<PublicShop>(`/shops/${slug}`)
      .then(setShop)
      .catch((e: ApiError) => setLoadError(e.status === 404 ? t('notFound') : e.message))
  }, [slug, t])

  if (!shop) {
    return (
      <Shell>
        <div className="flex justify-center py-16 text-ink-muted">{loadError ? <Banner tone="danger">{loadError}</Banner> : <Spinner className="h-8 w-8" />}</div>
      </Shell>
    )
  }
  const offered = shop.orders.enabled ? SERVICES.filter((s) => shop.orders.services.some((x) => x.id === s.id)) : []
  const setting = shop.orders.services.find((x) => x.id === serviceId)
  if (serviceId && setting) return <OrderForm shop={shop} svc={serviceOf(serviceId)} setting={setting} />

  const daysText = (d: number) => (d === 0 ? t('sameDay') : d === 1 ? t('fromDay1') : t('fromDays', { d }))
  return (
    <Shell shop={shop} wide>
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('pickTitle')}</h1>
        <p className="text-ink-muted">{t('pickIntro')}</p>
      </div>
      {offered.length === 0 ? (
        <Card className="p-5 text-center">{t('pickNone')}</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {offered.map((s) => {
            const st = shop.orders.services.find((x) => x.id === s.id)!
            const featured = s.id === 'blackbook'
            return (
              <Link
                key={s.id}
                to={`/s/${slug}/order/${s.id}`}
                className={`flex items-center gap-3 rounded border-[1.5px] p-4 hover:border-action ${featured ? 'border-ink bg-surface sm:col-span-2 lg:col-span-1' : 'border-line bg-surface'}`}
              >
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded ${featured ? 'bg-ink text-[#E8C872]' : 'bg-surface-tint text-action'}`}>
                  <ServiceIcon id={s.id} className="h-6 w-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{t(`svc_${s.id}` as Key)}</span>
                  <span className="block text-sm text-ink-muted">{t(`svcHint_${s.id}` as Key)}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{daysText(st.leadDays)}</span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden />
              </Link>
            )
          })}
        </div>
      )}
    </Shell>
  )
}

function OrderForm({ shop, svc, setting }: { shop: PublicShop; svc: ServiceDef; setting: ServiceSetting }) {
  const slug = shop.slug
  const { t } = useI18n()
  const navigate = useNavigate()
  const [files, setFiles] = useState<PickedFile[]>([])
  const [copies, setCopies] = useState(svc.copies ?? 1)
  const [binding, setBinding] = useState<Binding>(svc.binding ?? 'spiral')
  const [colourPages, setColourPages] = useState('')
  const [pages, setPages] = useState('')
  const [quantity, setQuantity] = useState('')
  const [size, setSize] = useState('')
  const [description, setDescription] = useState('')
  const [cover, setCover] = useState<CoverText>({ title: '', student: '', college: '' })
  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')
  const [due, setDue] = useState(addDays(todayIST(), Math.max(1, setting.leadDays)))
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [consent, setConsent] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)
  const pick = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)
  const draftKey = `${slug}/${svc.id}`

  const os = shop.orders
  const isDoc = svc.form === 'document'
  const minDue = addDays(todayIST(), setting.leadDays)
  const priceOf: Record<Binding, number> = { hard: os.hardPaise, spiral: os.spiralPaise, soft: os.softPaise, none: 0 }
  const bindLabel: Record<Binding, Key> = { hard: 'bindHard', spiral: 'bindSpiral', soft: 'bindSoft', none: 'bindNone' }
  const bindings: Binding[] = svc.id === 'bulk' || svc.id === 'binding' ? ['none', 'spiral', 'soft', 'hard'] : ['hard', 'spiral', 'soft']
  const unitName = svc.unit ? t(`unit_${svc.unit}` as Key) : ''
  const qty = Number(quantity) || 0
  const estimate = svc.form === 'quantity' ? quantityEstimate(svc, setting, qty) : 0
  const normalizedPhone = phone.trim().replace(/[\s-]/g, '').replace('+91', '')
  const phoneValid = !normalizedPhone || /^[6-9]\d{9}$/.test(normalizedPhone)
  const formValid =
    name.trim().length > 0 && name.trim().length <= 40 &&
    (!isDoc || files.length > 0) &&
    (!isDoc || ((Number(pages) || 0) >= 0 && (Number(pages) || 0) <= 2000)) &&
    (svc.form !== 'quantity' || (qty >= 1 && qty <= 100000)) &&
    (svc.form !== 'custom' || (description.trim().length >= 3 && description.trim().length <= 500)) &&
    (svc.proof !== 'cover' || (!!cover.title.trim() && !!cover.student.trim() && !!cover.college.trim() && [cover.title, cover.student, cover.rollNo, cover.course, cover.college, cover.guide, cover.year, cover.spine, cover.extra].every((v) => (v ?? '').length <= 200))) &&
    (svc.proof !== 'text' || (!!text.trim() && text.length <= 1000)) &&
    phoneValid && consent && due >= minDue
  const setC = (k: keyof CoverText) => (e: React.ChangeEvent<HTMLInputElement>) => setCover((c) => ({ ...c, [k]: e.target.value }))

  useEffect(() => {
    let active = true
    loadOrderDraft<StoredOrderDraft>(draftKey)
      .then((draft) => {
        if (!active || !draft) return
        setFiles(draft.files.map((f) => ({ id: f.id, file: f.file, mime: mimeOf(f.file), pages: f.pages, progress: 0, status: 'ready' })))
        setCopies(draft.copies)
        setBinding(draft.binding)
        setColourPages(draft.colourPages)
        setPages(draft.pages)
        setQuantity(draft.quantity)
        setSize(draft.size)
        setDescription(draft.description)
        setCover(draft.cover)
        setText(draft.text)
        setNotes(draft.notes)
        setDue(draft.due < minDue ? minDue : draft.due)
        setName(draft.name)
        setPhone(draft.phone)
        setConsent(draft.consent)
      })
      .catch(() => undefined)
      .finally(() => { if (active) setRestored(true) })
    return () => { active = false }
  }, [draftKey, minDue])

  useEffect(() => {
    if (!restored || submitted.current) return
    const draft: StoredOrderDraft = {
      files: files.map(({ id, file, pages }) => ({ id, file, pages })),
      copies, binding, colourPages, pages, quantity, size, description, cover, text, notes, due, name, phone, consent,
    }
    const timeout = window.setTimeout(() => {
      saveOrderDraft(draftKey, draft).catch(() => setError(t('draftSaveFailed')))
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [restored, draftKey, files, copies, binding, colourPages, pages, quantity, size, description, cover, text, notes, due, name, phone, consent, t])

  const patch = (id: string, p: Partial<PickedFile>) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const onPick = async (list: FileList | null) => {
    if (!list) return
    setError('')
    for (const file of Array.from(list)) {
      const mime = mimeOf(file)
      if (!ALLOWED_MIMES.has(mime)) {
        setError(t('fileNotSupported', { name: file.name }))
        continue
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        setError(`${file.name} is ${bytes(file.size)}. The limit is ${MAX_FILE_MB} MB.`)
        continue
      }
      const pf: PickedFile = { id: `f${n++}`, file, mime, pages: fileKind(mime) === 'image' ? 1 : 0, progress: 0, status: 'ready' }
      setFiles((fs) => [...fs, pf])
      if (mime === 'application/pdf') {
        const r = await checkPdf(file)
        if (r.locked) {
          setFiles((fs) => fs.filter((f) => f.id !== pf.id))
          setError(t('locked'))
          continue
        }
        pf.pages = r.pages
        patch(pf.id, { pages: r.pages })
        if (isDoc && r.pages > 0) setPages((p) => p || String(r.pages))
      }
    }
  }

  const spec = (): OrderSpec => {
    if (isDoc) return { copies, binding, bothSides: false, colourPages, pages: Number(pages) || 0, notes }
    if (svc.form === 'quantity') return { quantity: qty, size, notes }
    return { description, notes }
  }
  const proof = (): CoverText => (svc.proof === 'cover' ? cover : { title: '', student: '', college: '', text })

  const send = async () => {
    setError('')
    const missing: string[] = []
    if (!name.trim()) missing.push(t('bbName'))
    if (isDoc && files.length === 0) {
      missing.push(t('bbFile'))
    }
    if (svc.form === 'quantity' && qty < 1) missing.push(t('qtyLabel', { unit: unitName }))
    if (svc.form === 'custom' && description.trim().length < 3) missing.push(t('descLabel'))
    if (svc.proof === 'cover') {
      if (!cover.title.trim()) missing.push(t('cTitle'))
      if (!cover.student.trim()) missing.push(t('cStudent'))
      if (!cover.college.trim()) missing.push(t('cCollege'))
    }
    if (svc.proof === 'text' && !text.trim()) missing.push(t('textLabel'))
    if (!consent) missing.push(t('bbConsentShort'))
    if (missing.length) {
      setError(t('bbRequiredDetails', { fields: missing.join(', ') }))
      return
    }
    setSending(true)
    try {
      const res = await api<{ view: OrderView; secret: string; uploads: UploadTarget[] }>(`/shops/${slug}/orders`, {
        body: {
          service: svc.id,
          customerName: name,
          phone,
          dueDate: due,
          consent,
          spec: spec(),
          cover: proof(),
          files: files.map((f) => ({ clientId: f.id, filename: f.file.name, size: f.file.size, mime: f.mime })),
        },
      })
      const { order } = res.view
      for (const target of res.uploads ?? []) {
        const f = files.find((x) => x.id === target.clientId)
        if (!f) continue
        patch(f.id, { status: 'uploading' })
        await uploadFile(
          f.file,
          target,
          (p) => patch(f.id, { progress: p }),
          (w) => patch(f.id, { status: w ? 'waiting' : 'uploading' }),
        )
        await api(`/orders/${order.id}/files/${target.fileId}/complete`, { body: { pages: f.pages }, secret: res.secret })
        patch(f.id, { status: 'done', progress: 1 })
      }
      await api(`/orders/${order.id}/submit`, { body: {}, secret: res.secret })
      saveOrder({ orderId: order.id, secret: res.secret, slug, shopName: shop.name, code: order.code, savedAt: Date.now() })
      submitted.current = true
      await clearOrderDraft(draftKey).catch(() => undefined)
      navigate(`/o/${order.id}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('uploadFailed'))
      setFiles((fs) => fs.map((f) => (f.status === 'done' ? f : { ...f, status: 'ready', progress: 0 })))
    } finally {
      setSending(false)
    }
  }

  const fileCard = (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">{isDoc ? t('bbFile') : t('designFile')}{isDoc && <span className="ml-1 text-danger" aria-hidden="true">*</span>}</h2>
      {files.map((f) => {
        const Icon = fileKind(f.mime) === 'document' ? FileType : FileText
        return (
          <div key={f.id} className="rounded border-[1.5px] border-line p-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-tint text-action">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{f.file.name}</div>
                <div className="text-xs text-ink-muted">
                  {bytes(f.file.size)}
                  {f.pages > 0 ? ` · ${t('pages', { n: f.pages })}` : ''}
                </div>
              </div>
              {!sending && f.status !== 'done' && (
                <button type="button" onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))} className="p-2 text-ink-muted hover:text-danger" aria-label={`${t('remove')} ${f.file.name}`}>
                  <Trash2 className="h-5 w-5" aria-hidden />
                </button>
              )}
            </div>
            {(f.status === 'uploading' || f.status === 'waiting' || f.status === 'done') && (
              <div className="mt-2 h-1 overflow-hidden rounded bg-divider">
                <div className="h-full bg-action transition-all" style={{ width: `${Math.round(f.progress * 100)}%` }} />
              </div>
            )}
            {f.status === 'waiting' && (
              <p className="mt-1 flex items-center gap-1 text-xs text-attention">
                <WifiOff className="h-3 w-3" aria-hidden /> {t('waitingNetwork')}
              </p>
            )}
          </div>
        )
      })}
      <Button variant="secondary" className="w-full" onClick={() => pick.current?.click()} disabled={sending}>
        <Plus className="h-5 w-5" aria-hidden /> {files.length ? t('addMore') : t('bbChoose')}
      </Button>
      <p className="text-xs text-ink-muted">{isDoc ? t('bbFileHint') : t('designFileHint')}</p>
    </Card>
  )

  if (!restored) return <Shell shop={shop}><div className="flex justify-center py-16"><Spinner className="h-8 w-8" /></div></Shell>

  return (
    <Shell shop={shop} wide>
      <div className="flex items-start gap-3">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded ${svc.id === 'blackbook' ? 'bg-ink text-[#E8C872]' : 'bg-surface-tint text-action'}`}>
          <ServiceIcon id={svc.id} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className="text-2xl font-bold">{t(`svc_${svc.id}` as Key)}</h1>
            <Link to={`/s/${slug}/order`} className="text-sm font-semibold text-action hover:underline">
              {t('changeService')}
            </Link>
          </div>
          <p className="text-ink-muted">{t('bbIntro')}</p>
          <p className="text-xs text-ink-muted"><span className="text-danger" aria-hidden="true">*</span> {t('requiredLegend')}</p>
        </div>
      </div>
      <input ref={pick} type="file" multiple accept={ACCEPTED} className="hidden" onChange={(e) => onPick(e.target.files).finally(() => (e.target.value = ''))} />

      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
        <div className="space-y-3">
          {isDoc && fileCard}

          <Card className="space-y-4 p-4">
            {isDoc && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">{t('bbCopies')}</div>
                    {svc.proof === 'cover' && <div className="text-xs text-ink-muted">{t('bbCopiesHint')}</div>}
                  </div>
                  <Stepper label={t('bbCopies')} value={copies} max={svc.id === 'bulk' ? 1000 : 50} onChange={setCopies} />
                </div>
                <div>
                  <div className="mb-2 font-semibold">{t('bbBinding')}</div>
                  <Segmented<Binding>
                    label={t('bbBinding')}
                    value={binding}
                    onChange={setBinding}
                    options={bindings.map((b) => ({ value: b, label: t(bindLabel[b]), hint: priceOf[b] ? t('perCopy', { p: rupees(priceOf[b]) }) : undefined }))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('bbPages')} hint={t('bbPagesHint')}>
                    <input className={input} inputMode="numeric" value={pages} onChange={(e) => setPages(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                  </Field>
                  <Field label={t('bbColour')} hint={t('bbColourHint')}>
                    <input className={input} value={colourPages} onChange={(e) => setColourPages(e.target.value)} placeholder="1,5-7" />
                  </Field>
                </div>
              </>
            )}
            {svc.form === 'quantity' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label={t('qtyLabel', { unit: unitName })}
                    required
                    hint={
                      setting.unitPaise
                        ? (svc.unitSize ?? 1) > 1
                          ? t('qtyPerLot', { p: rupees(setting.unitPaise), n: svc.unitSize ?? 1, unit: unitName })
                          : t('qtyEach', { p: rupees(setting.unitPaise) })
                        : undefined
                    }
                  >
                    <input className={`${input} font-mono`} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                  </Field>
                  <Field label={t('sizeLabel')} hint={t('sizeHint')}>
                    <input className={input} value={size} maxLength={40} onChange={(e) => setSize(e.target.value)} />
                  </Field>
                </div>
                {estimate > 0 && <p className="rounded bg-surface-tint p-3 text-sm font-semibold">{t('qtyEstimate', { p: rupees(estimate) })}</p>}
              </>
            )}
            {svc.form === 'custom' && (
              <Field label={t('descLabel')} hint={t('descHint')} required>
                <textarea className={`${input} h-28 py-2`} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
              </Field>
            )}
            <Field label={t('bbNotes')}>
              <input className={input} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </Card>

          {!isDoc && fileCard}
        </div>

        <div className="space-y-3">
          {svc.proof === 'cover' && (
            <Card className="space-y-3 p-4">
              <div>
                <h2 className="font-semibold">{t('bbCover')}</h2>
                <p className="text-xs text-ink-muted">{t('bbCoverHint')}</p>
              </div>
              <Field label={t('cTitle')} required>
                <input className={input} value={cover.title} onChange={setC('title')} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('cStudent')} required>
                  <input className={input} value={cover.student} onChange={setC('student')} />
                </Field>
                <Field label={t('cRoll')}>
                  <input className={input} value={cover.rollNo ?? ''} onChange={setC('rollNo')} />
                </Field>
                <Field label={t('cCourse')}>
                  <input className={input} value={cover.course ?? ''} onChange={setC('course')} placeholder="T.Y.B.Com" />
                </Field>
                <Field label={t('cYear')}>
                  <input className={input} value={cover.year ?? ''} onChange={setC('year')} placeholder="2026–27" />
                </Field>
              </div>
              <Field label={t('cCollege')} required>
                <input className={input} value={cover.college} onChange={setC('college')} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('cGuide')}>
                  <input className={input} value={cover.guide ?? ''} onChange={setC('guide')} />
                </Field>
                <Field label={t('cSpine')}>
                  <input className={input} value={cover.spine ?? ''} onChange={setC('spine')} />
                </Field>
              </div>
              <Field label={t('cExtra')}>
                <input className={input} value={cover.extra ?? ''} onChange={setC('extra')} />
              </Field>
            </Card>
          )}
          {svc.proof === 'text' && (
            <Card className="space-y-2 p-4">
              <Field label={t('textLabel')} hint={t('textHint')} required>
                <textarea className={`${input} h-32 py-2 font-mono text-sm`} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder={'Ravi Patil\nPatil Electricals\n98200 12345'} />
              </Field>
            </Card>
          )}

          <Card className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('bbName')} required>
                <input className={input} value={name} maxLength={40} autoComplete="name" onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label={t('bbDue')} hint={setting.leadDays > 0 ? t('bbDueHint', { d: setting.leadDays }) : undefined}>
                <input className={input} type="date" min={minDue} value={due} onChange={(e) => setDue(e.target.value)} />
              </Field>
            </div>
            <Field label={t('bbPhone')} hint={t('bbPhoneHint')}>
              <input className={input} inputMode="tel" autoComplete="tel" value={phone} maxLength={14} onChange={(e) => setPhone(e.target.value)} placeholder="98xxxxxxxx" />
            </Field>
            <label className="flex gap-3 rounded bg-surface-tint p-3 text-sm">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--action)]" />
              <span className="flex gap-2">
                <ShieldCheck className="h-5 w-5 shrink-0 text-ready" aria-hidden />
                <span>{t('bbConsent', { d: os.fileDays })}<span className="ml-1 text-danger" aria-hidden="true">*</span></span>
              </span>
            </label>
          </Card>

          {error && <Banner tone="danger">{error}</Banner>}
          <div className="pt-1">
            <Button size="lg" className="w-full" onClick={send} disabled={sending || !formValid}>
              {sending ? <Spinner /> : null}
              {sending ? t('sending') : t('bbSend')}
            </Button>
            <p className="mt-2 text-center text-xs text-ink-muted">{t('bbPriceNote')}</p>
          </div>
        </div>
      </div>
    </Shell>
  )
}
