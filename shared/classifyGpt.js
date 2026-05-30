import { DefaultAzureCredential } from '@azure/identity'
import { getKdlCodeSystem } from './kdlCodeSystem.js'

const openaiEndpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '')
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4-mini'
const tokenScope = 'https://cognitiveservices.azure.com/.default'
const MAX_PAGES = 50

const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined
})

// Simple in-memory cache: input hash → { result, timestamp }
const responseCache = new Map()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const CACHE_MAX_SIZE = 500

// --- Prompt: context-aware (pages labeled, GPT sees surrounding pages) ---
const CONTEXT_AWARE_PROMPT = `You are a clinical document classifier. You assign KDL codes (Klinische Dokumentenklassen-Liste, DVMD) to clinical content.

You will receive:
1. A list of all valid KDL codes with their display names and definitions
2. Clinical text labeled by page number from a multi-page document

Your task: for EACH page, pick the single best-matching KDL code. You may use context from neighboring pages (e.g. "Fortsetzung" references, related content). Think like a medical records professional who looks at each page in the context of the full document.

Respond in this exact JSON format, nothing else:
{"results":[{"page":<number>,"code":"<KDL code>","display":"<German display name>","confidence":<0.0-1.0>,"reasoning":"<one sentence in German>"}]}`

// --- Prompt: independent (each text block stands alone, no page numbers, no neighbor context) ---
const INDEPENDENT_PROMPT = `You are a clinical document classifier. You assign KDL codes (Klinische Dokumentenklassen-Liste, DVMD) to clinical content.

You will receive:
1. A list of all valid KDL codes with their display names and definitions
2. Multiple independent clinical text blocks, each labeled with an ID number

Your task: for EACH text block, pick the single best-matching KDL code. Treat each block as a completely independent document — do NOT use context from other blocks. Think like a medical records professional classifying a single loose page.

Respond in this exact JSON format, nothing else:
{"results":[{"id":<number>,"code":"<KDL code>","display":"<German display name>","confidence":<0.0-1.0>,"reasoning":"<one sentence in German>"}]}`

/**
 * Classify pages of clinical content against the DVMD KDL CodeSystem using GPT-4o.
 *
 * Dual-call verification (Option A):
 *   Call 1 — context-aware:  pages labeled with page numbers, GPT sees the full document
 *   Call 2 — independent:    same texts as unlabeled blocks, GPT treats each in isolation
 *   Both calls run in parallel.
 *   Agreement → verified, confidence boosted.
 *   Disagreement → flagged, higher-confidence result wins, disagreement details exposed.
 *
 * Returns { classifications: [...], primaryClassification, codeSystem }
 */
export async function classifyPages ({ pages, languageHint = 'mixed' }) {
  if (pages.length > MAX_PAGES) {
    throw new Error(`Document exceeds ${MAX_PAGES} page limit (got ${pages.length}).`)
  }

  const kdl = await getKdlCodeSystem()
  const codeSystemInfo = buildCodeSystemInfo(kdl)

  const nonEmpty = pages.filter(p => p.text && p.text.trim())
  if (!nonEmpty.length) {
    return { classifications: [], primaryClassification: null, codeSystem: codeSystemInfo }
  }

  // Check cache
  const cacheResults = new Map()
  const uncached = []
  for (const p of nonEmpty) {
    const key = hashInput(`${p.style || ''}:${p.text.trim()}`)
    const cached = responseCache.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      cacheResults.set(p.page, { ...cached.result, page: p.page, cached: true })
    } else {
      uncached.push(p)
    }
  }

  let gptResults = []
  if (uncached.length > 0) {
    const kdlHeader = `## KDL CodeSystem (${kdl.meta.version}, ${kdl.meta.date})\n\n${kdl.prompt}`

    // Collect page images for handwritten/mixed pages (vision input)
    const pageImages = uncached
      .filter(p => p.imageBase64 && (p.style === 'handwritten' || p.style === 'mixed'))
      .map(p => ({ page: p.page, base64: p.imageBase64, contentType: p.imageContentType || 'image/jpeg' }))

    // Single page: skip dual-call, use independent prompt only
    if (uncached.length === 1) {
      const independentMsg = `${kdlHeader}\n\n## Independent text blocks to classify\n\n` +
        uncached.map(p => {
          const styleHint = p.style ? `Schrifterkennung: ${p.style === 'handwritten' ? 'handschriftlich' : p.style === 'mixed' ? 'gedruckt mit handschriftlichen Anteilen' : 'gedruckt'}\n` : ''
          const imageHint = p.imageBase64 ? '[Originalbild beigefügt]\n' : ''
          return `--- Block ${p.page} ---\n${styleHint}${imageHint}${p.text.trim()}`
        }).join('\n\n')

      const raw = await callGpt(independentMsg, uncached.length, INDEPENDENT_PROMPT, pageImages)
      const results = parseMultiPageResponse(raw, uncached, kdl, 'id')
      gptResults = results.map(r => ({ ...r, verified: true, verificationMethod: 'single-page', cached: false }))
    } else {
    // Multi-page: dual-call verification
    // --- Call 1: context-aware (pages labeled, neighbors visible) ---
    const contextAwareMsg = `${kdlHeader}\n\n## Document pages to classify\n\n` +
      uncached.map(p => {
        const styleHint = p.style ? `Schrifterkennung: ${p.style === 'handwritten' ? 'handschriftlich' : p.style === 'mixed' ? 'gedruckt mit handschriftlichen Anteilen' : 'gedruckt'}\n` : ''
        const imageHint = p.imageBase64 ? '[Originalbild beigefügt]\n' : ''
        return `--- Page ${p.page} ---\n${styleHint}${imageHint}${p.text.trim()}`
      }).join('\n\n')

    // --- Call 2: independent (blocks labeled with IDs, no page numbers) ---
    const independentMsg = `${kdlHeader}\n\n## Independent text blocks to classify\n\n` +
      uncached.map(p => {
        const styleHint = p.style ? `Schrifterkennung: ${p.style === 'handwritten' ? 'handschriftlich' : p.style === 'mixed' ? 'gedruckt mit handschriftlichen Anteilen' : 'gedruckt'}\n` : ''
        const imageHint = p.imageBase64 ? '[Originalbild beigefügt]\n' : ''
        return `--- Block ${p.page} ---\n${styleHint}${imageHint}${p.text.trim()}`
      }).join('\n\n')

    // Run both calls in parallel
    const [contextRaw, independentRaw] = await Promise.all([
      callGpt(contextAwareMsg, uncached.length, CONTEXT_AWARE_PROMPT, pageImages),
      callGpt(independentMsg, uncached.length, INDEPENDENT_PROMPT, pageImages)
    ])

    const contextResults = parseMultiPageResponse(contextRaw, uncached, kdl, 'page')
    const independentResults = parseMultiPageResponse(independentRaw, uncached, kdl, 'id')

    const contextMap = new Map(contextResults.map(r => [r.page, r]))
    const independentMap = new Map(independentResults.map(r => [r.page, r]))

    // Reconcile: compare per page
    gptResults = uncached.map(p => {
      const ctx = contextMap.get(p.page)
      const ind = independentMap.get(p.page)

      if (!ctx && !ind) {
        return fallbackResult(p.page)
      }
      if (!ctx) return { ...ind, verified: false, verificationMethod: 'independent-only' }
      if (!ind) return { ...ctx, verified: false, verificationMethod: 'context-only' }

      if (ctx.code === ind.code) {
        // Agreement — verified, boost confidence
        const boosted = Math.min(1, Math.max(ctx.confidence, ind.confidence) * 1.05)
        return {
          page: p.page,
          code: ctx.code,
          display: ctx.display,
          classId: ctx.classId,
          confidence: Math.round(boosted * 100) / 100,
          reasoning: ctx.reasoning,
          verified: true,
          verificationMethod: 'dual-call-agree',
          cached: false
        }
      } else {
        // Disagreement — pick higher confidence, prefer context-aware on ties
        const winner = ctx.confidence >= ind.confidence ? ctx : ind
        const loser = winner === ctx ? ind : ctx
        const penalized = Math.round(winner.confidence * 0.85 * 100) / 100
        return {
          page: p.page,
          code: winner.code,
          display: winner.display,
          classId: winner.classId,
          confidence: penalized,
          reasoning: winner.reasoning,
          verified: false,
          verificationMethod: 'dual-call-disagree',
          disagreement: {
            contextAware: { code: ctx.code, display: ctx.display, confidence: ctx.confidence, reasoning: ctx.reasoning },
            independent: { code: ind.code, display: ind.display, confidence: ind.confidence, reasoning: ind.reasoning }
          },
          cached: false
        }
      }
    })
    } // end multi-page dual-call

    // Cache each result
    for (const r of gptResults) {
      const originalPage = uncached.find(p => p.page === r.page)
      if (originalPage) {
        const key = hashInput(`${originalPage.style || ''}:${originalPage.text.trim()}`)
        if (responseCache.size >= CACHE_MAX_SIZE) {
          const oldest = responseCache.keys().next().value
          responseCache.delete(oldest)
        }
        // Cache without page number and transient fields
        const { page: _p, cached: _c, ...cacheable } = r
        responseCache.set(key, { result: cacheable, timestamp: Date.now() })
      }
    }
  }

  // Merge cached + fresh, sorted by page
  const classifications = nonEmpty
    .map(p => cacheResults.get(p.page) || gptResults.find(r => r.page === p.page))
    .filter(Boolean)
    .sort((a, b) => a.page - b.page)

  return {
    classifications,
    codeSystem: codeSystemInfo
  }
}

/**
 * Classify moments (text segments without page info).
 * Wraps each moment as a page and delegates to classifyPages.
 */
export async function classifyMoments ({ moments, languageHint = 'mixed' }) {
  const pages = moments.map((m, i) => ({
    page: i + 1,
    text: `${m.text || m.spokenText || ''}`.trim()
  }))
  return classifyPages({ pages, languageHint })
}

async function callGpt (userMessage, pageCount, systemPrompt, images = []) {
  if (!openaiEndpoint) {
    throw new Error('AZURE_OPENAI_ENDPOINT is not configured.')
  }

  const token = await credential.getToken(tokenScope)
  const url = `${openaiEndpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=2024-12-01-preview`

  // Scale max_tokens with page count
  const maxTokens = Math.min(4000, 1000 + pageCount * 80)

  // Build user content: text-only or multimodal (text + images for handwritten pages)
  let userContent
  if (images.length > 0) {
    userContent = [
      { type: 'text', text: userMessage },
      ...images.map(img => ({
        type: 'image_url',
        image_url: { url: `data:${img.contentType};base64,${img.base64}`, detail: 'auto' }
      }))
    ]
  } else {
    userContent = userMessage
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
      max_completion_tokens: maxTokens,
      response_format: { type: 'json_object' }
    })
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Azure OpenAI call failed (${res.status}): ${detail.slice(0, 300)}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

function buildCodeSystemInfo (kdl) {
  return {
    url: kdl.meta.url,
    version: kdl.meta.version,
    title: kdl.meta.title,
    date: kdl.meta.date,
    publisher: kdl.meta.publisher,
    codeCount: kdl.meta.count,
    lastFetched: new Date(kdl.fetchedAt).toISOString()
  }
}

function fallbackResult (page) {
  return {
    page, code: 'UB999999', display: 'Sonstige medizinische Dokumentation', classId: 'UB',
    confidence: 0.1, reasoning: 'Keine GPT-Zuordnung für diese Seite.', verified: false,
    verificationMethod: 'none', cached: false
  }
}

/**
 * Parse GPT multi-page JSON response.
 * @param {string} pageKey - 'page' for context-aware, 'id' for independent prompt
 */
function parseMultiPageResponse (raw, pages, kdl, pageKey) {
  try {
    const parsed = JSON.parse(raw)
    const results = parsed.results || []

    return pages.map(p => {
      const match = results.find(r => r[pageKey] === p.page)
      if (!match) {
        return fallbackResult(p.page)
      }
      const valid = kdl.leafCodes.find(c => c.code === match.code)
      return {
        page: p.page,
        code: valid ? match.code : 'UB999999',
        display: valid ? valid.display : 'Sonstige medizinische Dokumentation',
        classId: valid ? match.code.substring(0, 2) : 'UB',
        confidence: Math.max(0, Math.min(1, Number(match.confidence) || 0)),
        reasoning: `${match.reasoning || ''}`.slice(0, 200) || 'Keine Begründung verfügbar.',
        cached: false
      }
    })
  } catch {
    return pages.map(p => fallbackResult(p.page))
  }
}

function hashInput (text) {
  // Simple fast hash for cache key
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0
  }
  return `${h}_${text.length}`
}
