import { DefaultAzureCredential } from '@azure/identity'
import { customAlphabet } from 'nanoid'

const nanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 16)
const topicEndpoint = (process.env.EVENT_GRID_TOPIC_ENDPOINT || '').replace(/\/api\/events.*$/, '').replace(/\/$/, '')
const tokenScope = 'https://eventgrid.azure.net/.default'

const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined
})

/**
 * Publish a vidaugment.kdl.classified event to the configured Event Grid topic.
 * Silently skips if EVENT_GRID_TOPIC_ENDPOINT is not set.
 */
export async function publishKdlClassifiedEvent ({
  masterSessionId,
  sessionId,
  chunkIndex,
  classification,
  moments
}) {
  if (!topicEndpoint) return

  const token = await credential.getToken(tokenScope)

  const event = [{
    id: nanoid(),
    eventType: 'vidaugment.kdl.classified',
    subject: `masterSession/${masterSessionId}/kdl`,
    eventTime: new Date().toISOString(),
    dataVersion: '1.0',
    data: {
      masterSessionId,
      sessionId: sessionId || null,
      chunkIndex: chunkIndex ?? null,
      classification,
      momentCount: Array.isArray(moments) ? moments.length : 0,
      classifiedAt: new Date().toISOString()
    }
  }]

  const res = await fetch(`${topicEndpoint}/api/events?api-version=2018-01-01`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.token}`
    },
    body: JSON.stringify(event)
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Event Grid publish failed: ${res.status} ${body.slice(0, 200)}`)
  }
}
