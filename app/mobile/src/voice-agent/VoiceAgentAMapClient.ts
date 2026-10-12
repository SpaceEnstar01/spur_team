import type { RideRoute } from './voiceAgentPolicy'

type FetchLike = typeof fetch

function textContent(payload: any): string[] {
  if (payload?.error || payload?.result?.isError || !Array.isArray(payload?.result?.content)) {
    throw new Error('AMap returned an invalid response')
  }
  const items = payload.result.content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
  if (!items.length) throw new Error('AMap returned no location')
  return items.map((item: any) => item.text)
}

function coordinate(value: string): [string, string] | undefined {
  const match = value.match(/^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/)
  if (!match) return undefined
  const lon = Number(match[1]); const lat = Number(match[2])
  return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90 ? [match[1], match[2]] : undefined
}

function taxiParams(uri: string): Map<string, string> | undefined {
  const prefix = 'amapuri://drive/takeTaxi?'
  if (!uri.startsWith(prefix)) return undefined
  const values = new Map<string, string>()
  try {
    for (const pair of uri.slice(prefix.length).split('&')) {
      const index = pair.indexOf('=')
      if (index < 1) return undefined
      const name = decodeURIComponent(pair.slice(0, index).replace(/\+/g, ' '))
      const value = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, ' '))
      if (values.has(name)) return undefined
      values.set(name, value)
    }
    return values
  } catch { return undefined }
}

export async function createTaxiURI(route: RideRoute, apiKey: string, fetcher: FetchLike = fetch, signal?: AbortSignal): Promise<string> {
  if (!route.destination.trim() || !apiKey.trim()) throw new Error('AMap destination or Debug key is missing')
  const call = async (id: number, name: string, args: Record<string, string>) => {
    const response = await fetcher(`https://mcp.amap.com/mcp?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    })
    if (!response.ok) throw new Error(`AMap ${name} failed`)
    return textContent(await response.json())
  }
  const geocode = async (address: string, id: number): Promise<[string, string]> => {
    const geo = await call(id, 'maps_geo', { address })
    for (const line of geo) {
      try {
        const result = JSON.parse(line)
        for (const item of result?.results || []) {
          const coords = coordinate(item?.location || '')
          if (coords) return coords
        }
      } catch { /* non-JSON tool text */ }
    }
    throw new Error(`AMap could not locate ${address}`)
  }
  const [originCoords, destinationCoords] = await Promise.all([
    route.origin ? geocode(route.origin, 1) : Promise.resolve(undefined),
    geocode(route.destination, route.origin ? 2 : 1),
  ])
  const args = {
    ...(originCoords ? { slon: originCoords[0], slat: originCoords[1], sname: route.origin! } : {}),
    dlon: destinationCoords[0], dlat: destinationCoords[1], dname: route.destination,
  }
  const taxi = await call(route.origin ? 3 : 2, 'maps_schema_take_taxi', args)
  for (const line of taxi) {
    const uri = line.match(/amapuri:\/\/drive\/takeTaxi\?[^\s"'<>]+/)?.[0]
    if (!uri || uri.length > 2048) continue
    const params = taxiParams(uri)
    if (!params) continue
    const matchingDestination = Number(params.get('dlon')) === Number(destinationCoords[0]) &&
      Number(params.get('dlat')) === Number(destinationCoords[1]) && params.get('dname') === route.destination
    const matchingOrigin = !originCoords || (Number(params.get('slon')) === Number(originCoords[0]) &&
      Number(params.get('slat')) === Number(originCoords[1]) && params.get('sname') === route.origin)
    if (matchingDestination && matchingOrigin) return uri
  }
  throw new Error('AMap returned a taxi page without the requested pickup or destination')
}
