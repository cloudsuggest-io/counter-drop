// Counts PDF pages on the phone with pdf.js (loaded only when a PDF is picked).
// Returns 0 when the file can't be read (locked or damaged); staff then confirm at the counter.

export type PdfCheck = { pages: number; locked: boolean }

// Above this size the PDF isn't read on the phone: loading hundreds of MB into memory can crash a
// mobile browser tab. The job goes through with "pages to confirm" and staff confirm at the counter.
const MAX_CHECK_BYTES = 100 * 1024 * 1024

export async function checkPdf(file: File): Promise<PdfCheck> {
  if (file.size > MAX_CHECK_BYTES) return { pages: 0, locked: false }
  try {
    const pdfjs = await import('pdfjs-dist')
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    const data = new Uint8Array(await file.arrayBuffer())
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
    const pages = doc.numPages
    await doc.destroy()
    return { pages, locked: false }
  } catch (e) {
    const name = (e as { name?: string }).name ?? ''
    return { pages: 0, locked: name === 'PasswordException' }
  }
}
