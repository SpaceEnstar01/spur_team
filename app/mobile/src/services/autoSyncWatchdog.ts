const STALLED_TRANSFER_MS = 30_000

export function shouldRetryStalledSync(inFlight: boolean, lastActivityAt: number, now: number): boolean {
  return inFlight && lastActivityAt > 0 && now - lastActivityAt >= STALLED_TRANSFER_MS
}
