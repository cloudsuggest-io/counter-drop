import { useCallback, useEffect, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { api, ApiError, store } from '@/lib/api'
import { Banner, Button, Card } from '@/components/ui'
import { PinPad } from '@/components/PinPad'
import { useShopAuth, useShopTheme } from './auth'
import { AuthLayout } from './AuthLayout'

// Staff sign-in: shop link name → name tile → 4-digit PIN (FSD SCR-S02, R1a without phone OTP).
export default function LoginPage() {
  useShopTheme()
  const { session, login } = useShopAuth()
  const [params] = useSearchParams()
  const [slug, setSlug] = useState(params.get('shop') ?? store.get('cd.shop.slug') ?? '')
  const [shop, setShop] = useState<{ name: string; slug: string } | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const findShop = async (s: string) => {
    setError('')
    try {
      const res = await api<{ shop: { name: string; slug: string }; names: string[] }>(`/shop/staff-names?shop=${encodeURIComponent(s.trim().toLowerCase())}`)
      setShop(res.shop)
      setNames(res.names)
    } catch (e) {
      setShop(null)
      setError(e instanceof ApiError && e.status === 404 ? 'No shop with that link name.' : 'Could not reach the server.')
    }
  }

  useEffect(() => {
    if (slug) findShop(slug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const press = useCallback(
    async (digit: string) => {
      if (busy || !shop || !name) return
      const next = (pin + digit).slice(0, 4)
      setPin(next)
      if (next.length === 4) {
        setBusy(true)
        try {
          await login(shop.slug, name, next)
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'Could not sign in')
          setPin('')
        } finally {
          setBusy(false)
        }
      }
    },
    [busy, shop, name, pin, login],
  )
  const del = useCallback(() => setPin((p) => p.slice(0, -1)), [])

  if (session) return <Navigate to="/shop" replace />

  return (
    <AuthLayout subtitle="Shop sign in">
      {error && <Banner tone="danger">{error}</Banner>}

      {!shop ? (
        <Card className="p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              findShop(slug)
            }}
          >
            <label htmlFor="slug" className="block font-semibold">
              Shop link name
            </label>
            <input
              id="slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="xerox"
              className="mt-2 h-12 w-full rounded border-[1.5px] border-line bg-surface px-3 font-mono"
            />
            <p className="mt-1 text-xs text-ink-muted">
              The name in your shop's QR link: …/s/<b>your-shop</b>
            </p>
            <p className="mt-2 text-xs text-ink-muted">First time? Open the one-time setup link you were sent to choose your PIN.</p>
            <Button className="mt-3 w-full" type="submit" disabled={!slug.trim()}>
              Continue
            </Button>
          </form>
        </Card>
      ) : !name ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">{shop.name}</h2>
            <button className="text-sm font-semibold text-action" onClick={() => setShop(null)}>
              Change shop
            </button>
          </div>
          <p className="mb-2 text-sm text-ink-muted">Who's at the counter?</p>
          {names.length === 0 && <p className="text-sm">Nobody has set a PIN yet. Open the setup link you were sent.</p>}
          <div className="grid grid-cols-2 gap-2">
            {names.map((n) => (
              <Button key={n} variant="secondary" size="lg" onClick={() => setName(n)}>
                {n}
              </Button>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">{name}</h2>
            <button
              className="text-sm font-semibold text-action"
              onClick={() => {
                setName('')
                setPin('')
              }}
            >
              Not you?
            </button>
          </div>
          <p className="text-sm text-ink-muted">Enter your 4-digit PIN</p>
          <PinPad value={pin} onDigit={press} onDelete={del} busy={busy} />
          <p className="mt-3 text-center text-xs text-ink-muted">Forgot your PIN? Ask the shop owner for a new PIN link.</p>
        </Card>
      )}
    </AuthLayout>
  )
}
