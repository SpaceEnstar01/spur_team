type FetchLike = typeof fetch

export async function generateVoiceAgentImage(
  prompt: string,
  baseUrl: string,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<{ output: string; imageUrl: string }> {
  if (!prompt.trim()) throw new Error('Image prompt is empty')
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/api/assistant/skill-refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ instruction: prompt, transcript: prompt, skill: 'image' }),
  })
  if (!response.ok) throw new Error(`Image request failed (${response.status})`)
  const data = await response.json()
  if (typeof data?.imageUrl !== 'string' || !/^https?:\/\//.test(data.imageUrl)) {
    throw new Error('Image service did not return an image')
  }
  return { output: typeof data.output === 'string' && data.output.trim() ? data.output : 'Image is ready', imageUrl: data.imageUrl }
}
