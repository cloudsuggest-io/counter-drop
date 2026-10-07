import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { ArrowLeft, BadgeCheck, Camera, Globe2, LockKeyhole, MapPin, Printer, Zap } from 'lucide-react'
import { Button, Logo } from '@/components/ui'
import { useShopAuth } from './auth'

// Printable counter standee poster (FSD SCR-S08). Always printed light, whatever the board theme.
export default function QrPage() {
  const { session } = useShopAuth()
  const [svg, setSvg] = useState('')
  const url = session ? `${window.location.origin}/s/${session.shop.slug}` : ''

  useEffect(() => {
    if (!url) return
    QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
      width: 380,
    }).then(setSvg)
  }, [url])

  if (!session) return null
  const { shop } = session
  const displayURL = url.replace(/^https?:\/\//, '')
  const privacyURL = `${window.location.host}/privacy`

  return (
    <div className="min-h-screen bg-[#0f172a] px-3 py-6 text-slate-950 print:bg-white print:p-0" data-theme="light">
      <div className="mx-auto mb-6 flex max-w-[760px] items-center gap-3 print:hidden">
        <Link to="/shop" className="rounded-xl p-2 text-white/80 hover:bg-white/10 hover:text-white" aria-label="Back to queue">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <h1 className="flex-1 text-xl font-bold text-white">Counter QR standee</h1>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden /> Print Standee / Poster
        </Button>
      </div>

      <article className="poster-sheet mx-auto flex w-full max-w-[720px] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl print:h-[297mm] print:w-[210mm] print:max-w-none print:rounded-none print:border-0 print:shadow-none">
        <div className="h-3 bg-gradient-to-r from-sky-400 via-blue-600 to-indigo-600" />

        <div className="flex flex-1 flex-col gap-6 px-7 py-7 sm:px-10 print:gap-3 print:px-[9mm] print:py-[7mm]">
          <header className="space-y-5 text-center print:space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4 print:pb-2">
              <div className="flex items-center gap-3 text-left">
                <Logo size={42} />
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-950">Counter Drop</p>
                  <p className="-mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-sky-600">Instant Print Workflow</p>
                </div>
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Live Desk Connected
              </div>
            </div>

            <div>
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-black uppercase tracking-wide text-slate-700 print:mb-1 print:text-[10px]">
                <MapPin className="h-3.5 w-3.5 text-blue-600" aria-hidden /> Station Desk #01
              </div>
              <h2 className="text-2xl font-black leading-tight tracking-tight text-slate-950 sm:text-3xl print:text-2xl">
                {shop.slug} <span className="font-semibold text-blue-600">•</span> {shop.name || 'Xerox'}
              </h2>
              {shop.address && <p className="mt-1 text-sm font-medium text-slate-500">{shop.address}</p>}
            </div>

            <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 px-5 py-5 text-white shadow-xl print:px-4 print:py-3">
              <div className="pointer-events-none absolute -bottom-10 -right-8 h-36 w-36 rounded-full bg-sky-500/10 blur-2xl" />
              <div className="mb-2 inline-flex items-center rounded-full border border-sky-400/40 bg-sky-400/20 px-3 py-0.5 text-xs font-bold uppercase tracking-wider text-sky-300 print:mb-1 print:text-[10px]">
                🚀 10-second contactless drop
              </div>
              <h3 className="text-2xl font-black leading-tight sm:text-[28px] print:text-[22px]">
                Scan &amp; Drop Your Files.
                <br />
                <span className="text-sky-400 underline decoration-sky-500/40 decoration-2 underline-offset-4">No WhatsApp.</span> No App Install.
              </h3>
              <div className="mt-3 space-y-1 border-t border-slate-800 pt-3 text-xs font-semibold text-slate-300 sm:text-sm print:mt-2 print:pt-2 print:text-[10px]">
                <p>
                  <span className="text-white">हिंदी:</span> फ़ाइलें प्रिंट के लिए तुरंत भेजें · कोई ऐप या नंबर शेयर करने की ज़रूरत नहीं
                </p>
                <p className="text-slate-400">
                  <span className="text-slate-300">मराठी:</span> प्रिंटसाठी फाइल्स लगेच स्कॅन करा · व्हॉट्सॲप किंवा फोन नंबरची गरज नाही
                </p>
              </div>
            </section>
          </header>

          <section className="flex justify-center" aria-label={`QR code for ${url}`}>
            <div className="relative rounded-[26px] border-2 border-slate-200 bg-white p-5 shadow-xl print:p-3">
              <span className="absolute left-2 top-2 h-6 w-6 rounded-tl-xl border-l-4 border-t-4 border-sky-400" />
              <span className="absolute right-2 top-2 h-6 w-6 rounded-tr-xl border-r-4 border-t-4 border-sky-400" />
              <span className="absolute bottom-2 left-2 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 border-sky-400" />
              <span className="absolute bottom-2 right-2 h-6 w-6 rounded-br-xl border-b-4 border-r-4 border-sky-400" />

              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-black tracking-wide text-sky-900 print:mb-2 print:text-[10px]">
                <Camera className="h-4 w-4 text-sky-600" aria-hidden /> Point phone camera here • Opens instantly
              </div>

              <div className="relative mx-auto h-72 w-72 bg-white p-2 sm:h-80 sm:w-80 print:h-56 print:w-56">
                <div className="h-full w-full [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
                <div className="absolute inset-0 m-auto flex h-14 w-14 items-center justify-center rounded-2xl border-4 border-white bg-slate-950 p-2 shadow-lg">
                  <Logo size={36} />
                </div>
              </div>

              <div className="mt-3 flex items-center justify-center gap-2 text-[11px] font-bold text-slate-500 print:mt-2 print:text-[10px]">
                <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> Supports PDF and image files
              </div>
            </div>
          </section>

          <section className="grid gap-3.5 md:grid-cols-3 print:grid-cols-3 print:gap-2">
            <StepCard n="1" tone="blue" title="Scan & Drop" body="No app download, no WhatsApp contact saving, no number leaks." local="कोई ऐप नहीं, कोई नंबर शेयर नहीं" />
            <StepCard n="2" tone="sky" title="Choose & Preview" body="Choose B&W or Color, set copies, and send your files clearly." local="भेजने से पहले विकल्प चुनें" />
            <StepCard n="3" tone="emerald" title="Get Token & Pay" body="Get instant token ID. Collect prints and pay at the desk." local="टोकन दिखाएं व काउंटर पर भुगतान करें" />
          </section>

          <section className="flex flex-col items-center justify-between gap-3 rounded-xl bg-gradient-to-r from-slate-950 to-slate-800 px-4 py-3 text-xs text-slate-200 shadow-inner sm:flex-row print:gap-2 print:px-3 print:py-2 print:text-[10px]">
            <div className="flex items-center gap-2.5">
              <span className="rounded-lg bg-slate-800 p-1.5 text-emerald-400">
                <LockKeyhole className="h-4 w-4" aria-hidden />
              </span>
              <span>
                <strong className="font-bold text-white">Privacy Protected:</strong> Files are automatically deleted after pickup.
              </span>
            </div>
            <div className="flex items-center gap-1.5 border-t border-slate-700 pt-2 text-[11px] text-slate-300 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
              <Zap className="h-3.5 w-3.5 text-amber-400" aria-hidden /> Direct High-Speed Dispatch
            </div>
          </section>

          <footer className="flex flex-col items-center justify-between gap-2 border-t border-slate-200 pt-3 text-[11px] text-slate-500 sm:flex-row print:pt-2 print:text-[9px]">
            <div className="flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 font-mono text-slate-600">
              <Globe2 className="h-3.5 w-3.5 text-slate-400" aria-hidden /> {displayURL}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400">
              <span>Privacy: {privacyURL}</span>
              <span>•</span>
              <span className="font-medium text-slate-500">Counter Drop Systems</span>
            </div>
          </footer>
        </div>

        <div className="h-1.5 bg-slate-950" />
      </article>

      <div className="mt-6 flex justify-center print:hidden">
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden /> Print Standee / Poster (Ctrl+P)
        </Button>
      </div>
    </div>
  )
}

function StepCard({ n, tone, title, body, local }: { n: string; tone: 'blue' | 'sky' | 'emerald'; title: string; body: string; local: string }) {
  const colors = {
    blue: 'bg-blue-600 hover:border-blue-400',
    sky: 'bg-sky-500 hover:border-sky-400',
    emerald: 'bg-emerald-600 hover:border-emerald-400',
  }
  return (
    <article className={`rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition-colors print:p-2.5 ${colors[tone]}`}>
      <div className={`mb-2.5 flex h-8 w-8 items-center justify-center rounded-xl text-sm font-black text-white shadow-sm print:mb-1 print:h-6 print:w-6 print:text-xs ${colors[tone].split(' ')[0]}`}>{n}</div>
      <h3 className="mb-1 text-base font-extrabold text-slate-950 print:text-sm">{title}</h3>
      <p className="text-xs font-medium leading-relaxed text-slate-600 print:text-[10px]">{body}</p>
      <p className="mt-3 border-t border-slate-200/70 pt-2 text-[11px] font-medium text-slate-500 print:mt-2 print:pt-1 print:text-[9px]">{local}</p>
    </article>
  )
}
