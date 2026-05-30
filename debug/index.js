import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const htmlPath = path.resolve(__dirname, 'debug.html')

let cachedHtml = null

export default async function (context, req) {
  try {
    if (!cachedHtml) {
      cachedHtml = await readFile(htmlPath, 'utf8')
    }

    // Inject classify function key so debug page can call the protected endpoint
    const classifyKey = process.env.CLASSIFY_FUNCTION_KEY || ''
    const body = cachedHtml.replace('__CLASSIFY_KEY__', classifyKey)

    context.res = {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body
    }
  } catch (err) {
    context.log.error('debug page failed', err)
    context.res = { status: 500, body: 'Failed to load debug page.' }
  }
}
