export type AgentPromptKind = 'ride' | 'image' | 'chat'
export type RideRoute = { origin?: string; destination: string }

export function classifyPrompt(prompt: string): AgentPromptKind {
  const ride = /(?:打车|网约车|出租车|叫.{0,3}车|taxi|ride\s?hail)/i.exec(prompt)
  if (ride) {
    const before = prompt.slice(Math.max(0, ride.index - 8), ride.index)
    const negated = /(?:不要|别|不用|不想|取消|禁止|无需)\s*$/u.test(before)
    const informational = /(?:多少钱|费用|价格|要多久|怎么|如何|能不能|是不是|贵不贵|\bhow\b|\bprice\b|\bcost\b)/i.test(prompt)
    if (!negated && !informational) return 'ride'
  }
  if (/(?:画一?张|生成.{0,8}(?:图|照片)|绘制|生图|draw|generate.{0,12}image)/i.test(prompt)) return 'image'
  return 'chat'
}

export function extractRideDestination(prompt: string): string | undefined {
  return extractRideRoute(prompt)?.destination
}

export function extractRideRoute(prompt: string): RideRoute | undefined {
  if (classifyPrompt(prompt) !== 'ride') return undefined
  const explicit = prompt.match(/从\s*([^，。！？,!?]{1,60}?)\s*(?:打车|叫车|坐出租车|乘出租车)?\s*(?:到|去|前往)\s*([^，。！？,!?]{1,60})/u)
  const destination = (explicit?.[2] || prompt.match(/(?:去|到|前往|to)\s*([^，。！？,!?]{2,60})/i)?.[1])
    ?.replace(/(?:打车|吧|好吗|可以吗|谢谢|请帮我)\s*$/u, '').trim()
  if (!destination || (!explicit && /从[^，。！？,!?]{1,60}(?:打车|到|去|前往)/u.test(prompt))) return undefined
  const origin = explicit?.[1]?.trim()
  return origin && !/^(?:当前位置|这里|我现在的位置)$/u.test(origin) ? { origin, destination } : { destination }
}

export function validCoordinates(longitude: string, latitude: string): boolean {
  const pattern = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/
  if (!pattern.test(longitude) || !pattern.test(latitude)) return false
  const lon = Number(longitude)
  const lat = Number(latitude)
  return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90
}

export function validateTaxiURI(uri: string, destination: string, longitude: string, latitude: string): boolean {
  if (!destination.trim() || !validCoordinates(longitude, latitude) || uri.length > 2048) return false
  const prefix = 'amapuri://drive/takeTaxi?'
  if (!uri.startsWith(prefix)) return false
  try {
    const params = new URLSearchParams(uri.slice(prefix.length))
    for (const key of ['dlon', 'dlat', 'dname']) {
      if (params.getAll(key).length !== 1) return false
    }
    return validCoordinates(params.get('dlon') || '', params.get('dlat') || '') &&
      Number(params.get('dlon')) === Number(longitude) &&
      Number(params.get('dlat')) === Number(latitude) &&
      params.get('dname') === destination
  } catch {
    return false
  }
}
