export type AgentFile = {
  id: string
  name: string
  uri: string
  modifiedAt: number
  durationMs: number
}

export type AgentTask = {
  id: string
  source: 'ring' | 'phone' | 'text'
  startedAt: number
  endedAt?: number
  status: 'recording' | 'syncing' | 'transcribing' | 'responding' | 'completed' | 'failed' | 'ordinary'
  prompt?: string
  output?: string
  imageUrl?: string
  destination?: string
  file?: AgentFile
  error?: string
}

export type AgentState = { tasks: AgentTask[]; activeId?: string; activeRingId?: string }

function recordedAtFromName(file: AgentFile): number | undefined {
  const match = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.(?:m4a|ogg)$/i.exec(file.name)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match.map(Number)
  const time = Date.UTC(year, month - 1, day, hour, minute, second)
  const valid = new Date(time)
  if (valid.getUTCFullYear() !== year || valid.getUTCMonth() !== month - 1 || valid.getUTCDate() !== day ||
      valid.getUTCHours() !== hour || valid.getUTCMinutes() !== minute || valid.getUTCSeconds() !== second) return undefined
  return time
}

function recordedAt(file: AgentFile): number { return recordedAtFromName(file) ?? file.modifiedAt }

export function createVoiceAgentController(deps: { now?: () => number } = {}) {
  const now = deps.now || Date.now
  let state: AgentState = { tasks: [] }
  const listeners = new Set<(value: AgentState) => void>()
  const ownedFiles = new Set<string>()
  const knownFiles = new Set<string>()
  const knownAtStart = new Map<string, Set<string>>()
  const touchIdentities = new Set<number>()
  let lastRecordingState = 1
  const notify = () => listeners.forEach((listener) => listener(state))
  const mutate = (id: string, update: Partial<AgentTask>) => {
    state = { ...state, tasks: state.tasks.map((task) => task.id === id ? { ...task, ...update } : task) }
    notify()
  }
  const activeRing = () => state.tasks.find((task) => task.id === state.activeRingId)
  return {
    getState: () => state,
    subscribe(listener: (value: AgentState) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    restore(tasks: AgentTask[], priorOwned: string[] = []) {
      state = { tasks: tasks.slice(-40).map((task) =>
        ['recording', 'syncing', 'transcribing', 'responding'].includes(task.status)
          ? { ...task, status: 'failed' as const, error: 'Interrupted. Tap retry to continue.' }
          : task) }
      for (const id of priorOwned) ownedFiles.add(id)
      for (const task of tasks) if (task.file) ownedFiles.add(task.file.id)
      notify()
    },
    ownedFileIds: () => Array.from(ownedFiles),
    setKnownFiles(ids: string[]) { for (const id of ids) knownFiles.add(id) },
    clearHistory() {
      state = { tasks: [] }
      notify()
    },
    onRingTrigger(source: 'touch' | 'status', at = now(), identity?: number) {
      const current = activeRing()
      if (source === 'touch' && identity !== undefined && touchIdentities.has(identity)) return false
      if (current?.status === 'recording' && at - current.startedAt < 120_000) return false
      if (source === 'touch' && current?.status === 'syncing' && at - (current.endedAt || current.startedAt) < 1500) return false
      const task: AgentTask = { id: `ring-${at}`, source: 'ring', startedAt: at, status: 'recording' }
      if (source === 'touch' && identity !== undefined) {
        touchIdentities.add(identity)
        if (touchIdentities.size > 100) touchIdentities.delete(touchIdentities.values().next().value as number)
      }
      knownAtStart.set(task.id, new Set(knownFiles))
      state = { tasks: [...state.tasks, task].slice(-40), activeId: task.id, activeRingId: task.id }
      notify()
      return true
    },
    onRecordingStatus(value: number, at = now()) {
      const previous = lastRecordingState
      lastRecordingState = value
      if ((value === 2 || value === 3) && previous !== 2 && previous !== 3) return this.onRingTrigger('status', at)
      if (value === 1 || value === 4) {
        const task = activeRing()
        if (task?.status === 'recording') mutate(task.id, { status: 'syncing', endedAt: at })
      }
      return false
    },
    onSyncedFiles(files: AgentFile[]): AgentFile | undefined {
      const ringTasks = state.tasks.filter((task) => task.source === 'ring').sort((a, b) => a.startedAt - b.startedAt)
      const inWindow = (task: AgentTask, index: number, time: number) =>
        time >= task.startedAt - 5000 && time < (ringTasks[index + 1]?.startedAt ?? Infinity) - 500

      // Older Debug builds used conversion time and could assign a delayed file to a later task.
      // Release that assignment only when the filename identifies an earlier unfinished capture.
      for (const [index, task] of ringTasks.entries()) {
        if (!task.file || !files.some((file) => file.id === task.file?.id)) continue
        const captureTime = recordedAtFromName(task.file)
        if (captureTime === undefined || inWindow(task, index, captureTime)) continue
        const earlier = ringTasks.slice(0, index).some((candidate, candidateIndex) =>
          !candidate.file && (candidate.status === 'syncing' || candidate.status === 'failed') &&
          inWindow(candidate, candidateIndex, captureTime))
        if (!earlier) continue
        ownedFiles.delete(task.file.id)
        mutate(task.id, { status: 'failed', file: undefined, prompt: undefined, output: undefined,
          imageUrl: undefined, destination: undefined, error: 'Recording matched an earlier ring command; rematching this one.' })
      }

      for (const [index, task] of ringTasks.entries()) {
        if (task.file || (task.status !== 'syncing' && task.status !== 'failed')) continue
        const candidates = files.filter((file) =>
          !ownedFiles.has(file.id) && !knownAtStart.get(task.id)?.has(file.id) && inWindow(task, index, recordedAt(file)) && file.durationMs > 0 &&
          !file.name.startsWith('sample-') && !file.name.startsWith('demo_')).sort((a, b) => recordedAt(a) - recordedAt(b))
        const file = candidates.find((candidate) => candidate.durationMs < 15_000) || candidates[0]
        if (!file) {
          if (now() - task.startedAt > 5 * 60_000) {
            mutate(task.id, { status: 'failed', error: 'No new recording matched this ring task. Please record again.' })
          }
          continue
        }
        if (file.durationMs >= 15_000) {
          mutate(task.id, { status: 'ordinary', output: 'This was a longer recording. Find it in Recordings.' })
          continue
        }
        ownedFiles.add(file.id)
        mutate(task.id, { status: 'transcribing', file, error: undefined })
        return file
      }
      return undefined
    },
    isOwnedFile: (id: string) => ownedFiles.has(id),
    addText(prompt: string, source: 'text' | 'phone' = 'text') {
      const at = now()
      const task: AgentTask = { id: `${source}-${at}-${Math.random().toString(36).slice(2, 6)}`, source, startedAt: at, status: 'responding', prompt }
      state = { ...state, tasks: [...state.tasks, task].slice(-40), activeId: task.id }
      notify()
      return task
    },
    update: mutate,
  }
}

export type VoiceAgentController = ReturnType<typeof createVoiceAgentController>
