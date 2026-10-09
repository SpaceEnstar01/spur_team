type PermissionStatus = 'undetermined' | 'granted' | 'denied'

type PermissionRequests = {
  getMicrophone: () => Promise<PermissionStatus>
  requestMicrophone: () => Promise<unknown>
  requestSpeech: () => Promise<unknown>
}

/** Run the two independent iOS permission checks once, in system-alert order. */
export function createHomeVoicePermissionPrimer(requests: PermissionRequests): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    if (!pending) {
      pending = (async () => {
        try {
          if (await requests.getMicrophone() === 'undetermined') await requests.requestMicrophone()
        } catch {
          // Speech permission is independent of microphone permission.
        }
        await requests.requestSpeech()
      })()
    }
    return pending
  }
}
