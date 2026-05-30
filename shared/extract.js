import { DefaultAzureCredential } from '@azure/identity'

const visionEndpoint = (process.env.AZURE_AI_VISION_ENDPOINT || '').replace(/\/$/, '')
const speechEndpoint = (process.env.AZURE_AI_SPEECH_ENDPOINT || '').replace(/\/$/, '')
const docIntelligenceEndpoint = (process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT || '').replace(/\/$/, '')
const tokenScope = 'https://cognitiveservices.azure.com/.default'

const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined
})

const imageTypes = new Set([
  'image/jpeg', 'image/png', 'image/tiff', 'image/bmp', 'image/webp'
])

const audioTypes = new Set([
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp3',
  'audio/ogg',
  'audio/flac'
])

export function detectInputType (contentType) {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim()
  if (ct === 'application/json') return 'json'
  if (ct === 'application/pdf') return 'pdf'
  if (imageTypes.has(ct)) return 'image'
  if (audioTypes.has(ct)) return 'audio'
  return null
}

/**
 * Extract text from a binary file buffer.
 * Routes to Azure AI Vision Read (images/PDFs) or Azure AI Speech (audio).
 * Returns { pages: [{ page: number, text: string }] }
 */
export async function extractTextFromFile (buffer, contentType) {
  const inputType = detectInputType(contentType)

  if (inputType === 'image' || inputType === 'pdf') {
    return extractWithVisionRead(buffer, contentType)
  }
  if (inputType === 'audio') {
    return extractWithSpeech(buffer, contentType)
  }

  throw new Error(`Unsupported content type for extraction: ${contentType}`)
}

// ---------------------------------------------------------------------------
// Azure AI Vision Read (images + PDFs)
// Uses the Read 3.2 async API: submit → poll → collect text.
// ---------------------------------------------------------------------------

async function extractWithVisionRead (buffer, contentType) {
  if (!visionEndpoint) {
    throw new Error('AZURE_AI_VISION_ENDPOINT is not configured.')
  }

  const inputType = detectInputType(contentType)

  // Images: use v4.0 Image Analysis (synchronous, simpler)
  // PDFs: use Document Intelligence prebuilt-read (better handwriting OCR)
  if (inputType === 'image') {
    return extractImageV4(buffer, contentType)
  }
  return extractPdfWithDocIntelligence(buffer, contentType)
}

// ---------------------------------------------------------------------------
// Vision v4.0 Image Analysis — synchronous OCR for images
// ---------------------------------------------------------------------------

async function extractImageV4 (buffer, contentType) {
  const token = await credential.getToken(tokenScope)
  const url = `${visionEndpoint}/computervision/imageanalysis:analyze?features=read&api-version=2024-02-01`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': contentType
    },
    body: buffer
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Vision v4 Image Analysis failed (${res.status}): ${detail.slice(0, 200)}`)
  }

  const data = await res.json()
  const blocks = data?.readResult?.blocks || []
  const lines = []
  for (const block of blocks) {
    for (const line of (block.lines || [])) {
      const text = `${line.text || ''}`.trim()
      if (text) lines.push(text)
    }
  }

  // Detect handwriting from styles metadata
  const styles = data?.readResult?.styles || []
  const hasHandwritten = styles.some(s => s.isHandwritten && s.confidence > 0.5)
  const hasPrint = styles.some(s => !s.isHandwritten && s.confidence > 0.5)
  const style = hasHandwritten && hasPrint ? 'mixed' : hasHandwritten ? 'handwritten' : 'print'

  // For handwritten/mixed pages, carry the original image so GPT can see the document layout
  const pageData = { page: 1, text: lines.join('\n'), style }
  if (style === 'handwritten' || style === 'mixed') {
    pageData.imageBase64 = buffer.toString('base64')
    pageData.imageContentType = contentType
  }

  return { pages: [pageData] }
}

// ---------------------------------------------------------------------------
// Azure Document Intelligence — prebuilt-read for PDFs
// Better handwriting OCR than Vision v3.2. Same async pattern.
// ---------------------------------------------------------------------------

async function extractPdfWithDocIntelligence (buffer, contentType) {
  if (!docIntelligenceEndpoint) {
    throw new Error('AZURE_DOC_INTELLIGENCE_ENDPOINT is not configured.')
  }

  const token = await credential.getToken(tokenScope)
  const url = `${docIntelligenceEndpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`

  const submitRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': contentType
    },
    body: buffer
  })

  if (!submitRes.ok) {
    const detail = await submitRes.text().catch(() => '')
    throw new Error(`Document Intelligence submit failed (${submitRes.status}): ${detail.slice(0, 200)}`)
  }

  const operationUrl = submitRes.headers.get('operation-location')
  if (!operationUrl) {
    throw new Error('Document Intelligence did not return operation-location header.')
  }

  const result = await pollOperationResult(operationUrl, token.token)
  const pages = collectDocIntelligencePages(result)

  // Extract embedded JPEG images from scanned PDFs for handwritten pages
  const jpegImages = extractJpegImagesFromPdf(buffer)
  for (const page of pages) {
    if ((page.style === 'handwritten' || page.style === 'mixed') && jpegImages[page.page - 1]) {
      page.imageBase64 = jpegImages[page.page - 1].toString('base64')
      page.imageContentType = 'image/jpeg'
    }
  }

  return { pages }
}

async function pollOperationResult (operationUrl, bearerToken) {
  const maxAttempts = 60
  const intervalMs = 1000

  for (let i = 0; i < maxAttempts; i++) {
    await delay(intervalMs)

    const res = await fetch(operationUrl, {
      headers: { Authorization: `Bearer ${bearerToken}` }
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Operation poll failed (${res.status}): ${detail.slice(0, 200)}`)
    }

    const data = await res.json()

    if (data.status === 'succeeded') {
      return data
    }
    if (data.status === 'failed') {
      const err = data.error?.message || 'Operation failed.'
      throw new Error(`Document Intelligence failed: ${err}`)
    }
  }

  throw new Error('Document Intelligence timed out after 60 seconds.')
}

function collectDocIntelligencePages (result) {
  const analyzeResult = result?.analyzeResult || {}
  const diPages = analyzeResult.pages || []
  const styles = analyzeResult.styles || []

  // Build a set of handwritten spans for fast lookup
  const hwSpans = []
  for (const s of styles) {
    if (s.isHandwritten && (s.confidence ?? 0) > 0.5) {
      for (const span of (s.spans || [])) {
        hwSpans.push(span)
      }
    }
  }

  const pages = []
  for (const diPage of diPages) {
    const pageNum = diPage.pageNumber || pages.length + 1
    const lines = (diPage.lines || []).map(l => `${l.content || ''}`.trim()).filter(Boolean)

    // Determine handwriting ratio for this page by checking spans
    let hwCharCount = 0
    let totalCharCount = 0
    for (const line of (diPage.lines || [])) {
      const len = (line.content || '').length
      totalCharCount += len
      for (const span of (line.spans || [])) {
        const isHw = hwSpans.some(hw =>
          span.offset >= hw.offset && span.offset + span.length <= hw.offset + hw.length
        )
        if (isHw) hwCharCount += len
      }
    }

    const hwRatio = totalCharCount > 0 ? hwCharCount / totalCharCount : 0
    const style = hwRatio > 0.8 ? 'handwritten' : hwRatio > 0.2 ? 'mixed' : 'print'

    pages.push({ page: pageNum, text: lines.join('\n'), style })
  }

  return pages
}

// ---------------------------------------------------------------------------
// Extract embedded JPEG images from PDF buffer (scanned documents)
// Scanned clinical PDFs typically store each page as a JPEG stream.
// Returns an array of Buffers, one per image found, ordered by appearance.
// ---------------------------------------------------------------------------

function extractJpegImagesFromPdf (buffer) {
  const images = []
  const MIN_IMAGE_SIZE = 50000 // 50 KB — skip thumbnails/icons
  let pos = 0

  while (pos < buffer.length - 1) {
    // JPEG SOI marker: FF D8
    if (buffer[pos] === 0xFF && buffer[pos + 1] === 0xD8) {
      const start = pos
      pos += 2
      // Scan for EOI marker: FF D9
      while (pos < buffer.length - 1) {
        if (buffer[pos] === 0xFF && buffer[pos + 1] === 0xD9) {
          const end = pos + 2
          if (end - start >= MIN_IMAGE_SIZE) {
            images.push(buffer.subarray(start, end))
          }
          pos = end
          break
        }
        pos++
      }
    } else {
      pos++
    }
  }

  return images
}

// ---------------------------------------------------------------------------
// Azure AI Speech — fast transcription REST API
// POST multipart: audio file + JSON definition → transcript text.
// Supports WAV, MP3, OGG, FLAC up to ~5 min.
// ---------------------------------------------------------------------------

async function extractWithSpeech (buffer, contentType) {
  if (!speechEndpoint) {
    throw new Error('AZURE_AI_SPEECH_ENDPOINT is not configured.')
  }

  const token = await credential.getToken(tokenScope)
  const url = `${speechEndpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`

  const boundary = `----kdlclassifier${Date.now()}`
  const definition = JSON.stringify({ locales: ['de-DE', 'en-US'] })
  const ext = guessExtension(contentType)

  const body = buildMultipartBody(boundary, [
    {
      name: 'audio',
      filename: `input.${ext}`,
      contentType,
      data: buffer
    },
    {
      name: 'definition',
      contentType: 'application/json',
      data: Buffer.from(definition, 'utf8')
    }
  ])

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Speech transcription failed (${res.status}): ${detail.slice(0, 200)}`)
  }

  const result = await res.json()
  const phrases = result?.combinedPhrases || []
  const text = phrases.map(p => `${p.text || ''}`.trim()).filter(Boolean).join(' ')
  return { pages: [{ page: 1, text }] }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guessExtension (contentType) {
  if (contentType.includes('wav') || contentType.includes('wave')) return 'wav'
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3'
  if (contentType.includes('ogg')) return 'ogg'
  if (contentType.includes('flac')) return 'flac'
  return 'wav'
}

function buildMultipartBody (boundary, parts) {
  const chunks = []
  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`
      : `Content-Disposition: form-data; name="${part.name}"`

    chunks.push(
      Buffer.from(`--${boundary}\r\n${disposition}\r\nContent-Type: ${part.contentType}\r\n\r\n`, 'utf8'),
      Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'),
      Buffer.from('\r\n', 'utf8')
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(chunks)
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
