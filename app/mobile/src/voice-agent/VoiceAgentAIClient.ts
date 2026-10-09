import EventSource from 'react-native-sse'

export function visibleAnswer(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '').trim()
}

export function startLingReply(input: {
  prompt: string
  key: string
  history: { role: 'user' | 'assistant'; content: string }[]
  onChunk: (content: string) => void
}): { promise: Promise<string>; cancel: () => void } {
  if (!input.key.trim()) throw new Error('SiliconFlow Debug key is not configured')
  const source = new EventSource<'done'>('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${input.key}` },
    body: JSON.stringify({
      model: 'inclusionAI/Ling-flash-2.0', stream: true, max_tokens: 512, temperature: 0.3,
      messages: [
        { role: 'system', content: 'You are Spur Ring voice assistant. Answer concisely in the user’s language. Never invent live facts, personal data, orders or bookings.' },
        ...input.history.slice(-10),
        { role: 'user', content: input.prompt },
      ],
    }),
    pollingInterval: 0, timeoutBeforeConnection: 5000, timeout: 30000,
  })
  let raw = ''
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolvePromise: (value: string) => void = () => undefined
  let rejectPromise: (error: Error) => void = () => undefined
  const promise = new Promise<string>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  const cleanup = () => { if (timer) clearTimeout(timer); source.removeAllEventListeners(); source.close() }
  const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); rejectPromise(error) }
  const done = () => {
    if (settled) return
    settled = true
    cleanup()
    const output = visibleAnswer(raw)
    if (output) resolvePromise(output)
    else rejectPromise(new Error('Model returned no answer'))
  }
  const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => fail(new Error('Model response timed out')), 30000) }
  arm()
  source.addEventListener('message', (event) => {
    if (settled || !event.data) return
    const data = event.data.startsWith('data:') ? event.data.slice(5).trimStart() : event.data
    if (data.trim() === '[DONE]') { done(); return }
    try {
      const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content
      if (typeof chunk === 'string' && chunk) {
        raw += chunk
        input.onChunk(visibleAnswer(raw))
        arm()
      }
    } catch { /* ignore malformed event, timeout remains active */ }
  })
  source.addEventListener('done', done)
  source.addEventListener('error', () => fail(new Error('Model connection failed')))
  source.addEventListener('close', () => fail(new Error('Model connection closed')))
  return { promise, cancel: () => fail(new Error('Request cancelled')) }
}
