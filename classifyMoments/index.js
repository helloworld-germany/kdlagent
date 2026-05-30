import { classifyMoments as classifyMomentsGpt } from '../shared/classifyGpt.js'
import { publishKdlClassifiedEvent } from '../shared/eventGrid.js'

/**
 * Event Grid trigger — subscribes to vidaugment.moments.extracted events,
 * classifies moments against KDL vocabulary, and publishes a
 * vidaugment.kdl.classified event back to the topic.
 */
export default async function (context, eventGridEvent) {
  const data = eventGridEvent?.data || {}
  const masterSessionId = data.masterSessionId
  const sessionId = data.sessionId || null
  const chunkIndex = data.chunkIndex ?? null
  const moments = Array.isArray(data.moments) ? data.moments : []

  if (!masterSessionId) {
    context.log.warn('classifyMoments: missing masterSessionId, skipping')
    return
  }

  if (!moments.length) {
    context.log('classifyMoments: no moments in event, skipping', { masterSessionId })
    return
  }

  const languageHint = inferLanguageHint(moments)

  try {
    const result = await classifyMomentsGpt({ moments, languageHint })

    context.log('KDL classification result', {
      masterSessionId,
      sessionId,
      primary: result.primaryClassification?.code,
      pageCount: result.classifications.length,
      verified: result.classifications.filter(c => c.verified).length
    })

    await publishKdlClassifiedEvent({
      masterSessionId,
      sessionId,
      chunkIndex,
      classification: result,
      moments
    })
  } catch (err) {
    context.log.error('classifyMoments failed', {
      masterSessionId,
      error: err.message || String(err)
    })
    throw err
  }
}

function inferLanguageHint (moments) {
  const text = moments.map(m => `${m.spokenText || m.text || ''}`).join(' ').toLowerCase()
  const deSignals = ['der', 'die', 'das', 'und', 'ist', 'ein', 'mit', 'auf', 'für']
  const enSignals = ['the', 'and', 'for', 'with', 'patient', 'was']
  let de = 0
  let en = 0
  for (const w of deSignals) { if (text.includes(` ${w} `)) de++ }
  for (const w of enSignals) { if (text.includes(` ${w} `)) en++ }
  if (de > en) return 'de'
  if (en > de) return 'en'
  return 'mixed'
}
