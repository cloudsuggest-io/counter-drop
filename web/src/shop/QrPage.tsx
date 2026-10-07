import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { ArrowLeft, Check, Copy, Info, LockKeyhole, Printer } from 'lucide-react'
import { Button, Logo } from '@/components/ui'
import { useShopAuth } from './auth'

// Printable counter poster (FSD SCR-S08 / S12 QR kit). One A4 sheet that looks the same on screen and on paper.
// The sheet uses fixed light-theme colours (not the CSS variables) so the dark board theme never leaks into print,
// and `print-exact` keeps the ink bands when the browser would otherwise drop background colours.
const SHEET_W = 794 // A4 at 96 dpi = 210 mm
const SHEET_H = 1123 // 297 mm

export default function QrPage() {
  const { session } = useShopAuth()
  const [svg, setSvg] = useState('')
  const [copied, setCopied] = useState(false)
  const url = session ? `${window.location.origin}/s/${session.shop.slug}` : ''

  useEffect(() => {
    if (!url) return
    QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'H', // room for the logo in the middle
      margin: 0,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    }).then(setSvg)
  }, [url])

  // Scale the fixed-size sheet down to fit narrow screens; print always uses the full size.
  const frame = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const fit = () => setScale(Math.min(1, el.clientWidth / SHEET_W))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [session])

  if (!session) return null
  const { shop } = session
  const shortURL = url.replace(/^https?:\/\//, '')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked: the link is printed on the page anyway */
    }
  }

  return (
    <div className="min-h-screen bg-canvas text-ink print:min-h-0 print:bg-white">
      <header className="no-print border-b-[1.5px] border-line bg-surface">
        <div className="mx-auto flex max-w-[1000px] flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/shop" className="flex h-11 w-11 items-center justify-center rounded border-[1.5px] border-line" aria-label="Back to queue">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold">Counter QR poster</h1>
            <p className="hidden text-sm text-ink-subtle sm:block">A4 · put it where customers stand at the counter</p>
          </div>
          <Button variant="secondary" onClick={copy}>
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden /> Print A4 poster
          </Button>
        </div>
        <p className="flex items-start gap-2 border-t-[1.5px] border-line bg-surface-tint px-4 py-2 text-sm text-ink-muted">
          <span className="mx-auto flex max-w-[1000px] flex-1 items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-action" aria-hidden />
            <span>
              In the print dialog choose <b className="text-ink">A4</b>, margins <b className="text-ink">None</b>, and turn on{' '}
              <b className="text-ink">Background graphics</b>.
            </span>
          </span>
        </p>
      </header>

      <main className="px-4 py-6 print:p-0">
        <div ref={frame} className="mx-auto w-full max-w-[794px] print:max-w-none" style={{ height: SHEET_H * scale }}>
          <div
            className="origin-top-left print:!transform-none"
            style={{ width: SHEET_W, height: SHEET_H, transform: `scale(${scale})` }}
          >
            <Sheet svg={svg} url={url} shortURL={shortURL} name={shop.name || shop.slug} address={shop.address} />
          </div>
        </div>
      </main>
    </div>
  )
}

function Sheet({ svg, url, shortURL, name, address }: { svg: string; url: string; shortURL: string; name: string; address?: string }) {
  return (
    <article
      lang="en"
      className="print-exact flex h-full w-full flex-col overflow-hidden border-[1.5px] border-[#CBD5E1] bg-white text-[#0F172A] print:border-0"
      aria-label="Counter QR poster"
    >
      {/* Slim brand band */}
      <header className="flex items-center justify-between gap-6 bg-[#0F172A] px-12 py-5 text-white">
        <div className="flex items-center gap-3">
          <Logo size={44} />
          <div>
            <p className="text-[15px] font-bold tracking-[0.16em]">COUNTER DROP</p>
            <p className="text-[11px] font-semibold tracking-[0.14em] text-[#93C5FD]">SCAN · SEND · COLLECT</p>
          </div>
        </div>
        <div className="min-w-0 text-right">
          <p className="truncate text-[26px] font-bold leading-tight">{name}</p>
          {address && <p className="truncate text-sm text-[#CBD5E1]">{address}</p>}
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center px-12 pb-7 pt-9">
        <h2 className="text-center text-[40px] font-bold leading-[1.15] tracking-[-0.015em]">
          Scan to send your files <span className="text-[#2563EB]">for printing</span>
        </h2>
        <div className="mt-2 text-center text-[#334155]">
          <p lang="hi" className="text-xl font-semibold leading-normal">प्रिंट के लिए फ़ाइल भेजने को QR स्कैन करें</p>
          <p lang="mr" className="text-lg leading-normal">प्रिंटसाठी फाइल पाठवायला QR स्कॅन करा</p>
        </div>

        <section className="relative mt-7 rounded border-2 border-[#0F172A] p-6" aria-label={`QR code for ${url}`}>
          <Corner className="-left-2 -top-2 border-l-[6px] border-t-[6px]" />
          <Corner className="-right-2 -top-2 border-r-[6px] border-t-[6px]" />
          <Corner className="-bottom-2 -left-2 border-b-[6px] border-l-[6px]" />
          <Corner className="-bottom-2 -right-2 border-b-[6px] border-r-[6px]" />
          <div className="relative h-[390px] w-[390px]">
            <div className="h-full w-full [&_svg]:block [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="absolute inset-0 m-auto h-[80px] w-[80px] rounded bg-white p-1.5">
              <Logo size={68} />
            </div>
          </div>
        </section>

        <ul className="mt-6 flex gap-2.5 text-[15px] font-bold">
          {['No app', 'No phone number', 'No WhatsApp'].map((t) => (
            <li key={t} className="rounded border-[1.5px] border-[#BFDBFE] bg-[#EFF4FF] px-3.5 py-1.5">
              {t}
            </li>
          ))}
        </ul>

        <ol className="mt-auto grid w-full grid-cols-3 gap-3.5 pt-6">
          <Step n="1" color="#0F172A" title="Scan the QR" body="Opens in your phone browser. Nothing to install." local="QR स्कैन करें · QR स्कॅन करा" />
          <Step n="2" color="#2563EB" title="Send files, see the price" body="PDF or photos. Choose B/W or colour, copies, both sides." local="फ़ाइल भेजें, दाम पहले देखें" />
          <Step n="3" color="#15803D" title="Collect with your token" body={<>Show your token, e.g. <b className="font-mono">A-07</b>. Pay at the counter.</>} local="टोकन दिखाएँ, काउंटर पर पैसे दें" />
        </ol>
      </div>

      <footer className="flex items-center justify-between gap-6 bg-[#0F172A] px-12 py-5 text-white">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[#15803D]">
            <LockKeyhole className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-[15px] font-bold">Your files are deleted after pickup.</p>
            <p lang="hi" className="text-[13px] leading-normal text-[#CBD5E1]">प्रिंट लेने के बाद आपकी फ़ाइलें डिलीट हो जाती हैं।</p>
          </div>
        </div>
        <div className="min-w-0 text-right">
          <p className="text-[11px] font-semibold tracking-[0.08em] text-[#94A3B8]">QR NOT WORKING? TYPE</p>
          <p className="truncate font-mono text-[15px] font-bold text-[#93C5FD]">{shortURL}</p>
        </div>
      </footer>
    </article>
  )
}

function Corner({ className }: { className: string }) {
  return <span aria-hidden className={`absolute h-9 w-9 border-[#2563EB] ${className}`} />
}

function Step({ n, color, title, body, local }: { n: string; color: string; title: string; body: ReactNode; local: string }) {
  return (
    <li className="rounded border-[1.5px] border-[#CBD5E1] px-3.5 pb-3 pt-3.5">
      <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded font-mono text-lg font-bold text-white" style={{ background: color }}>
        {n}
      </span>
      <h3 className="text-[17px] font-bold leading-snug">{title}</h3>
      <p className="mt-1 text-[13.5px] leading-[1.45] text-[#334155]">{body}</p>
      <p lang="hi" className="mt-2 border-t border-[#E2E8F0] pt-1.5 text-[13.5px] leading-normal text-[#334155]">
        {local}
      </p>
    </li>
  )
}
