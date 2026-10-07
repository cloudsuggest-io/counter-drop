import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Check, Clock, Printer, PackageCheck, XCircle, Hourglass } from 'lucide-react'
import { useI18n, type Lang } from '@/lib/i18n'
import type { JobState } from '@/lib/types'

type Variant = 'primary' | 'ready' | 'secondary' | 'danger' | 'ghost'

const variants: Record<Variant, string> = {
  primary: 'bg-action text-white hover:bg-action-pressed active:bg-action-pressed border-2 border-transparent',
  ready: 'bg-ready text-white hover:opacity-90 border-2 border-transparent',
  secondary: 'bg-surface text-ink border-[1.5px] border-ink hover:bg-surface-tint',
  danger: 'bg-surface text-danger border-[1.5px] border-danger hover:bg-danger-bg',
  ghost: 'bg-transparent text-ink hover:bg-surface-tint border-2 border-transparent',
}

export function Button({ variant = 'primary', className = '', size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'min-h-[40px] px-3 text-sm', md: 'min-h-[48px] px-4 text-base', lg: 'min-h-[56px] px-5 text-lg' }
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${variants[variant]} ${className}`}
    />
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded border-[1.5px] border-line bg-surface ${className}`}>{children}</section>
}

export function Chip({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: 'neutral' | 'ready' | 'attention' | 'danger' | 'action' | 'dark'; className?: string }) {
  const tones = {
    neutral: 'bg-surface-tint text-ink',
    ready: 'bg-ready-bg text-ready',
    attention: 'bg-attention-bg text-attention',
    danger: 'bg-danger-bg text-danger',
    action: 'bg-action text-white',
    dark: 'bg-ink text-canvas',
  }
  return <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${tones[tone]} ${className}`}>{children}</span>
}

export function Logo({ size = 40 }: { size?: number }) {
  return <img src="/icon.svg" width={size} height={size} alt="Counter Drop" className="shrink-0 rounded-[22%]" />
}

export function LangSwitch() {
  const { lang, setLang } = useI18n()
  const opts: [Lang, string][] = [
    ['en', 'EN'],
    ['hi', 'हिं'],
    ['mr', 'मरा'],
  ]
  return (
    <div role="group" aria-label="Language" className="flex rounded-full border-[1.5px] border-line bg-surface p-0.5">
      {opts.map(([l, label]) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`min-h-[36px] min-w-[40px] rounded-full px-2 text-sm font-semibold ${lang === l ? 'bg-ink text-canvas' : 'text-ink-muted'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** Segmented tiles for settings (design/DESIGN.md §5). */
export function Segmented<T extends string | boolean>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string; disabled?: boolean }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`flex min-h-[56px] items-center justify-between rounded px-3 py-2 text-left disabled:opacity-40 ${on ? 'border-2 border-action bg-surface-tint' : 'border-[1.5px] border-line bg-surface'}`}
          >
            <span>
              <span className="block font-semibold">{o.label}</span>
              {o.hint && <span className="block text-xs text-ink-muted">{o.hint}</span>}
            </span>
            {on && <Check className="h-5 w-5 text-action" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

export function Stepper({ value, onChange, min = 1, max = 99, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  return (
    <div className="flex items-center rounded border-[1.5px] border-line bg-surface" role="group" aria-label={label}>
      <button type="button" className="h-12 w-12 text-xl font-bold disabled:opacity-30" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="−">
        −
      </button>
      <span className="w-10 text-center font-mono text-lg font-bold tabular" aria-live="polite">
        {value}
      </span>
      <button type="button" className="h-12 w-12 text-xl font-bold disabled:opacity-30" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="+">
        +
      </button>
    </div>
  )
}

export const stateMeta: Record<JobState, { tone: 'neutral' | 'ready' | 'attention' | 'danger' | 'action'; Icon: typeof Clock }> = {
  uploading: { tone: 'attention', Icon: Hourglass },
  queued: { tone: 'neutral', Icon: Clock },
  claimed: { tone: 'action', Icon: Printer },
  ready: { tone: 'ready', Icon: PackageCheck },
  collected: { tone: 'neutral', Icon: Check },
  cancelled: { tone: 'danger', Icon: XCircle },
}

export function Banner({ tone = 'neutral', children, action }: { tone?: 'neutral' | 'attention' | 'danger' | 'ready'; children: ReactNode; action?: ReactNode }) {
  const tones = {
    neutral: 'border-line bg-surface-tint',
    attention: 'border-attention bg-attention-bg text-attention',
    danger: 'border-danger bg-danger-bg text-danger',
    ready: 'border-ready bg-ready-bg text-ready',
  }
  return (
    <div role="status" className={`flex items-center gap-3 rounded border-[1.5px] px-3 py-2 text-sm font-medium ${tones[tone]}`}>
      <div className="flex-1">{children}</div>
      {action}
    </div>
  )
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} aria-hidden />
}
