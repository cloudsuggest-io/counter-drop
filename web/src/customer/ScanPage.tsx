import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CameraOff, ScanLine } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Banner, Button, Card } from '@/components/ui'
import { Shell } from './DropPage'

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

/**
 * Accepts only Counter Drop shop codes: a link to this app's own address with the path /s/<shop>.
 * Anything else (payment QRs, random websites, look-alike domains) is refused, so the scanner
 * can't be used to send people somewhere else.
 */
export function shopFromCode(raw: string, origin = window.location.origin): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.origin !== origin) return null
    const m = url.pathname.match(/^\/s\/([^/]+)\/?$/)
    const slug = m?.[1]?.toLowerCase()
    return slug && SLUG.test(slug) ? slug : null
  } catch {
    return null
  }
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }

// In-app scanner (installed PWA home → "Scan shop QR"). Uses the phone's built-in QR detector when
// available (Android Chrome) and a small JavaScript decoder otherwise (iPhone Safari).
export default function ScanPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const video = useRef<HTMLVideoElement>(null)
  const [camError, setCamError] = useState(false)
  const [notOurs, setNotOurs] = useState(false)
  const [manual, setManual] = useState('')

  const found = useCallback(
    (raw: string) => {
      const slug = shopFromCode(raw)
      if (slug) {
        navigator.vibrate?.(60)
        navigate(`/s/${slug}`, { replace: true })
        return true
      }
      setNotOurs(true)
      return false
    },
    [navigate],
  )

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    let pauseUntil = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamError(true)
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      } catch {
        setCamError(true)
        return
      }
      if (stopped || !video.current) return
      video.current.srcObject = stream
      await video.current.play().catch(() => {})

      const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector
      let detector: Detector | null = null
      if (Native) {
        try {
          detector = new Native({ formats: ['qr_code'] })
        } catch {
          detector = null
        }
      }
      const jsQR = detector ? null : (await import('jsqr')).default

      const tick = async () => {
        if (stopped) return
        const v = video.current
        if (v && v.readyState >= 2 && Date.now() > pauseUntil) {
          let value: string | undefined
          if (detector) {
            value = (await detector.detect(v).catch(() => []))[0]?.rawValue
          } else if (jsQR && ctx) {
            const w = Math.min(640, v.videoWidth)
            const h = Math.round((v.videoHeight * w) / (v.videoWidth || 1))
            canvas.width = w
            canvas.height = h
            ctx.drawImage(v, 0, 0, w, h)
            value = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data
          }
          if (value && !found(value)) pauseUntil = Date.now() + 2000
          if (value && shopFromCode(value)) return
        }
        timer = window.setTimeout(tick, 200)
      }
      tick()
    }
    start()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach((tr) => tr.stop())
    }
  }, [found])

  const goManual = (e: React.FormEvent) => {
    e.preventDefault()
    const slug = manual
      .trim()
      .toLowerCase()
      .replace(/^.*\/s\//, '')
      .replace(/\/$/, '')
    if (SLUG.test(slug)) navigate(`/s/${slug}`)
    else setNotOurs(true)
  }

  return (
    <Shell>
      <h1 className="flex items-center gap-2 text-xl font-bold">
        <ScanLine className="h-6 w-6 text-action" aria-hidden /> {t('scanTitle')}
      </h1>
      {notOurs && <Banner tone="attention">{t('scanNotOurs')}</Banner>}
      {!camError ? (
        <div className="relative overflow-hidden rounded border-2 border-ink bg-ink">
          <video ref={video} className="aspect-square w-full object-cover" muted playsInline aria-label={t('scanHintCam')} />
          <div className="pointer-events-none absolute inset-[18%] rounded border-4 border-white/80" aria-hidden />
          <p className="absolute inset-x-0 bottom-0 bg-black/60 p-2 text-center text-sm text-white">{t('scanHintCam')}</p>
        </div>
      ) : (
        <Card className="flex items-start gap-3 p-4">
          <CameraOff className="mt-0.5 h-6 w-6 shrink-0 text-attention" aria-hidden />
          <p className="text-sm">{t('scanNoCamera')}</p>
        </Card>
      )}
      <form onSubmit={goManual} className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="xerox"
          aria-label={t('scanManual')}
          autoCapitalize="none"
          autoCorrect="off"
          className="h-12 min-w-0 flex-1 rounded border-[1.5px] border-line bg-surface px-3 font-mono"
        />
        <Button type="submit" variant="secondary" disabled={manual.trim().length < 3}>
          {t('scanGo')}
        </Button>
      </form>
    </Shell>
  )
}
