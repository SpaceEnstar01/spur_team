export type VoiceIntentText = { transcript: string; intent: string }

type TranscriptionOptions = {
  local?: () => Promise<string>
  cancelLocal?: () => void
  cloud: () => Promise<VoiceIntentText>
  signal?: AbortSignal
  localTimeoutMs?: number
  onLocalFailure?: (error: unknown) => void
}

function cancelled(): Error { return new Error('Request cancelled') }

/** A local result is only usable if it contains speech; otherwise preserve cloud behavior. */
export async function transcribeWithLocalFallback(options: TranscriptionOptions): Promise<VoiceIntentText> {
  if (options.signal?.aborted) throw cancelled()
  if (!options.local) return options.cloud()

  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Local transcription timed out')), options.localTimeoutMs ?? 12_000)
    onAbort = () => reject(cancelled())
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })

  try {
    const transcript = (await Promise.race([options.local(), interruption])).trim()
    if (options.signal?.aborted) throw cancelled()
    if (!transcript) throw new Error('Local transcription was empty')
    return { transcript, intent: transcript }
  } catch (error) {
    if (options.signal?.aborted) {
      options.cancelLocal?.()
      throw cancelled()
    }
    options.cancelLocal?.()
    options.onLocalFailure?.(error)
    return options.cloud()
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}
