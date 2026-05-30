import { readFile, writeFile, mkdir } from 'fs/promises'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PACKAGE_REGISTRY = 'https://packages.simplifier.net/dvmd.kdl.r4'
const CACHE_DIR = path.resolve(__dirname, '../.kdl-cache')
const CACHE_FILE = path.join(CACHE_DIR, 'codesystem-kdl.json')
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

let cached = null // { codeSystem, meta, leafCodes, prompt, fetchedAt }

/**
 * Returns the full KDL CodeSystem with metadata, leaf codes, and a
 * pre-built prompt string for GPT. Fetches from Simplifier on first call
 * and refreshes every 24h.
 */
export async function getKdlCodeSystem () {
  if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) {
    return cached
  }

  // Try disk cache first
  const fromDisk = await loadFromDisk()
  if (fromDisk && Date.now() - fromDisk.fetchedAt < REFRESH_INTERVAL_MS) {
    cached = fromDisk
    return cached
  }

  // Fetch fresh from Simplifier
  try {
    const cs = await fetchCodeSystem()
    cached = buildCacheEntry(cs)
    await saveToDisk(cached)
    return cached
  } catch (err) {
    // If fetch fails but we have stale cache, use it
    if (fromDisk) {
      cached = fromDisk
      return cached
    }
    // Last resort: bundled fallback
    const fallback = await loadBundledFallback()
    cached = buildCacheEntry(fallback)
    return cached
  }
}

/**
 * Fetch the latest CodeSystem from Simplifier FHIR package registry.
 */
async function fetchCodeSystem () {
  // Get latest version
  const metaRes = await fetch(PACKAGE_REGISTRY)
  if (!metaRes.ok) throw new Error(`Registry meta failed: ${metaRes.status}`)
  const meta = await metaRes.json()
  const latestVersion = meta['dist-tags']?.latest
  if (!latestVersion) throw new Error('No latest version found in registry')

  // Download package tarball
  const tarUrl = `${PACKAGE_REGISTRY}/${latestVersion}`
  const tarRes = await fetch(tarUrl)
  if (!tarRes.ok) throw new Error(`Package download failed: ${tarRes.status}`)

  // Parse the tarball to find codesystem-kdl.xml.json
  const buffer = Buffer.from(await tarRes.arrayBuffer())
  const csJson = extractCodeSystemFromTar(buffer)
  return JSON.parse(csJson)
}

/**
 * Minimal tar extraction — finds codesystem-kdl.xml.json in a gzipped tar.
 */
function extractCodeSystemFromTar (gzBuffer) {
  const tar = gunzipSync(gzBuffer)

  let offset = 0
  while (offset < tar.length - 512) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.toString('utf8', 0, 100).replace(/\0/g, '')
    const sizeOctal = header.toString('utf8', 124, 136).replace(/\0/g, '').trim()
    const size = parseInt(sizeOctal, 8) || 0

    if (name.includes('codesystem-kdl')) {
      return tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
    }

    offset += 512 + Math.ceil(size / 512) * 512
  }

  throw new Error('codesystem-kdl not found in package tarball')
}

/**
 * Build the cached entry from a FHIR CodeSystem resource.
 */
function buildCacheEntry (cs) {
  const leafCodes = flattenLeafCodes(cs.concept || [])
  const meta = {
    url: cs.url,
    version: cs.version,
    title: cs.title,
    date: cs.date,
    publisher: cs.publisher,
    status: cs.status,
    count: leafCodes.length,
    totalCount: cs.count
  }

  // Build compact code list for GPT prompt (only leaf codes = level 3)
  const codeLines = leafCodes.map(c => {
    const def = c.definition ? ` — ${c.definition}` : ''
    return `${c.code}: ${c.display}${def}`
  })

  const prompt = codeLines.join('\n')

  return { codeSystem: cs, meta, leafCodes, prompt, fetchedAt: Date.now() }
}

/**
 * Recursively extract leaf codes (those without children = level 3 in KDL).
 */
function flattenLeafCodes (concepts) {
  const result = []
  for (const c of concepts) {
    if (c.concept && c.concept.length > 0) {
      result.push(...flattenLeafCodes(c.concept))
    } else {
      result.push({
        code: c.code,
        display: c.display,
        definition: c.definition || ''
      })
    }
  }
  return result
}

async function loadFromDisk () {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function saveToDisk (entry) {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(entry), 'utf8')
  } catch {
    // Non-critical
  }
}

async function loadBundledFallback () {
  const fallbackPath = path.resolve(__dirname, '../config/codesystem-kdl-fallback.json')
  const raw = await readFile(fallbackPath, 'utf8')
  return JSON.parse(raw)
}
