import type { UploadTarget } from './types'

/**
 * PUTs a file to its presigned URL with progress. Network drops are retried with backoff
 * (1, 2, 4 … up to 15 s) and wait for the browser to come back online.
 */
export async function uploadFile(file: File, target: UploadTarget, onProgress: (fraction: number) => void, onWaiting: (waiting: boolean) => void): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      await putOnce(file, target, onProgress)
      onWaiting(false)
      return
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0
      if (status >= 400 && status < 500) throw e // signature expired or mismatch: caller decides
      attempt++
      if (attempt > 8) throw e
      onWaiting(true)
      if (!navigator.onLine) await waitOnline()
      await sleep(Math.min(15000, 1000 * 2 ** (attempt - 1)))
    }
  }
}

function putOnce(file: File, target: UploadTarget, onProgress: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', target.url)
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1)
        resolve()
      } else reject(Object.assign(new Error('upload failed'), { status: xhr.status }))
    }
    xhr.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }))
    xhr.send(file)
  })
}

function waitOnline(): Promise<void> {
  return new Promise((resolve) => {
    const on = () => {
      window.removeEventListener('online', on)
      resolve()
    }
    window.addEventListener('online', on)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// What customers can send. Keep in step with domain.AllowedMimes on the API.
// Programs, scripts, HTML/SVG, macro-enabled Office files and archives are left out on purpose:
// they can run code when opened on the shop's computer.
const BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
}

export const ALLOWED_MIMES = new Set([...Object.values(BY_EXT), 'text/rtf'])

/**
 * The MIME type to upload with. Browsers often report an empty or generic type (HEIC on Android,
 * Word files from WhatsApp downloads come through as application/octet-stream), so an unknown
 * type falls back to the file extension.
 */
export function mimeOf(file: File): string {
  if (ALLOWED_MIMES.has(file.type)) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXT[ext] ?? (file.type || 'application/octet-stream')
}

export const ACCEPTED = [...Object.keys(BY_EXT).map((e) => '.' + e), ...ALLOWED_MIMES].join(',')

export type FileKind = 'pdf' | 'image' | 'document'

/** Same split as domain.FileKind: documents can't be page-counted on the phone. */
export function fileKind(mime: string): FileKind {
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  return 'document'
}

/** Files the shop's browser can open to print; the rest are downloaded (and the customer told). */
export function browserPrintable(mime: string): boolean {
  return ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'text/plain'].includes(mime)
}
