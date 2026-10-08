import { useEffect, useState } from 'react'
import { store } from './api'

// Install support for the PWA.
// Android/desktop Chrome & Edge fire `beforeinstallprompt`; we keep it so a button can show the native dialog.
// iPhone/iPad Safari has no prompt: the person uses Share → Add to Home Screen, so we show that hint instead.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // keep it for our own button instead of the browser's mini-bar
    deferred = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    store.set('cd.installed', '1')
    notify()
  })
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

const SNOOZE = 'cd.install.snoozed'
const snoozed = () => Number(store.get(SNOOZE) ?? 0) > Date.now()

export type InstallState = { mode: 'prompt' | 'ios' | 'none'; install: () => Promise<void>; dismiss: () => void }

/** What install help to offer here: a native prompt, the iPhone hint, or nothing (installed, snoozed, unsupported). */
export function useInstall(): InstallState {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  let mode: InstallState['mode'] = 'none'
  if (!isStandalone() && !snoozed()) {
    if (deferred) mode = 'prompt'
    else if (isIOS() && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)) mode = 'ios'
  }
  return {
    mode,
    install: async () => {
      if (!deferred) return
      await deferred.prompt()
      await deferred.userChoice
      // A prompt event can only be used once. If they backed out of the native dialog we don't snooze —
      // the browser fires a fresh `beforeinstallprompt` on the next page load and the button comes back.
      // Only an explicit "Not now" (dismiss) snoozes the card.
      deferred = null
      notify()
    },
    dismiss: () => {
      store.set(SNOOZE, String(Date.now() + 14 * 24 * 3600 * 1000))
      notify()
    },
  }
}
