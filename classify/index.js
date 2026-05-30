import { classifyPages, classifyMoments } from '../shared/classifyGpt.js'
import { detectInputType, extractTextFromFile } from '../shared/extract.js'

/**
 * HTTP POST /api/classify
 *
 * Accepts three input modes:
 *   1. JSON body with "text" (string) or "moments" (array)
 *   2. Raw image/PDF body → Vision Read → classify per page
 *   3. Raw audio body → Speech STT → classify
 *
 * Query params:
 *   ?languageHint=de   (optional, default "mixed")
 *
 * Response:
 *   { classifications, codeSystem, extractedPages?, inputType }
 */
export default async function (context, req) {
  const contentType = `${req.headers['content-type'] || ''}`.split(';')[0].trim().toLowerCase()
  const languageHint = `${req.query.languageHint || ''}`.trim() || 'mixed'
  const inputType = detectInputType(contentType)

  if (!inputType) {
    context.res = { status: 415, body: { error: `Unsupported content type: ${contentType}` } }
    return
  }

  try {
    let pages = []
    let detectedType = inputType

    if (inputType === 'json') {
      const body = req.body || {}
      if (body.file && body.fileContentType) {
        // Base64-encoded file in JSON body (used by debug page)
        const buffer = Buffer.from(body.file, 'base64')
        const fileType = detectInputType(body.fileContentType)
        if (!fileType || fileType === 'json') {
          context.res = { status: 415, body: { error: `Unsupported file type: ${body.fileContentType}` } }
          return
        }
        detectedType = fileType
        const extracted = await extractTextFromFile(buffer, body.fileContentType)
        pages = extracted.pages
      } else if (typeof body.text === 'string' && body.text.trim()) {
        pages = [{ page: 1, text: body.text.trim() }]
        detectedType = 'text'
      } else if (Array.isArray(body.moments) && body.moments.length) {
        const result = await classifyMoments({ moments: body.moments, languageHint })
        context.res = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { ...result, inputType: 'moments' }
        }
        return
      } else {
        context.res = { status: 400, body: { error: 'JSON body must contain "text" (string), "moments" (array), or "file" + "fileContentType".' } }
        return
      }
    } else {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.rawBody || '', 'binary')
      if (!buffer.length) {
        context.res = { status: 400, body: { error: 'Empty request body.' } }
        return
      }

      const extracted = await extractTextFromFile(buffer, contentType)
      pages = extracted.pages
      const hasText = pages.some(p => p.text && p.text.trim())
      if (!hasText) {
        context.res = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            classifications: [],
            inputType: detectedType,
            message: 'No text could be extracted from the input.'
          }
        }
        return
      }
    }

    const result = await classifyPages({ pages, languageHint })

    context.res = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        ...result,
        extractedPages: pages.map(p => ({ page: p.page, style: p.style || null, textLength: (p.text || '').length })),
        inputType: detectedType
      }
    }
  } catch (err) {
    context.log.error('classify failed', err)
    context.res = { status: 500, body: { error: err.message || 'Classification failed.' } }
  }
}
