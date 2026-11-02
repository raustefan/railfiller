export type Coord = [lon: number, lat: number]

export interface NewJourney {
  fromName: string
  toName: string
  trains: string
  line: Coord[]
  approximate: boolean
}

export interface Journey extends NewJourney {
  id: number
}

// Google polyline encoding; Transitous sends precision 6 for /plan and 5 for /map/trips.
export function decodePolyline(encoded: string, precision: number): Coord[] {
  const factor = 10 ** precision
  const line: Coord[] = []
  let i = 0
  let lat = 0
  let lon = 0
  const next = () => {
    let result = 0
    let shift = 0
    let byte: number
    do {
      byte = encoded.charCodeAt(i++) - 63
      // Multiplication instead of <<: precision 6 deltas can exceed 32 bits.
      result += (byte & 31) * 2 ** shift
      shift += 5
    } while (byte >= 32)
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2
  }
  while (i < encoded.length) {
    lat += next()
    lon += next()
    line.push([lon / factor, lat / factor])
  }
  return line
}

const EARTH_M = 6371000
const toRad = (deg: number) => (deg * Math.PI) / 180

export function lengthKm(line: Coord[]): number {
  let m = 0
  for (let i = 1; i < line.length; i++) {
    const [lon1, lat1] = line[i - 1]
    const [lon2, lat2] = line[i]
    const a =
      Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2
    m += 2 * EARTH_M * Math.asin(Math.sqrt(a))
  }
  return m / 1000
}

// ponytail: flat-earth projection around the point, fine for the few km a map tap covers.
export function distanceToLineM(point: Coord, line: Coord[]): number {
  const k = Math.cos(toRad(point[1]))
  const project = ([lon, lat]: Coord) => [toRad(lon - point[0]) * k * EARTH_M, toRad(lat - point[1]) * EARTH_M]
  let best = Infinity
  let prev = line.length ? project(line[0]) : null
  if (prev) best = Math.hypot(prev[0], prev[1])
  for (let i = 1; i < line.length; i++) {
    const cur = project(line[i])
    const dx = cur[0] - prev![0]
    const dy = cur[1] - prev![1]
    const len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, -(prev![0] * dx + prev![1] * dy) / len)) : 0
    best = Math.min(best, Math.hypot(prev![0] + t * dx, prev![1] + t * dy))
    prev = cur
  }
  return best
}

// The same stretch counts once in the atlas, whichever direction it was ridden in.
export function journeyKey(j: Pick<NewJourney, 'fromName' | 'toName' | 'line'>): string {
  return [[j.fromName, j.toName].sort().join('|'), Math.round(lengthKm(j.line) / 2)].join('|')
}

// The renderer talks to the internet, so its data is checked before it reaches the database.
export function parseNewJourney(value: unknown): NewJourney {
  const j = value as Partial<NewJourney> | null
  const validCoord = (c: unknown) =>
    Array.isArray(c) &&
    c.length === 2 &&
    typeof c[0] === 'number' &&
    typeof c[1] === 'number' &&
    Math.abs(c[0]) <= 180 &&
    Math.abs(c[1]) <= 90
  if (
    !j ||
    typeof j.fromName !== 'string' ||
    typeof j.toName !== 'string' ||
    typeof j.trains !== 'string' ||
    typeof j.approximate !== 'boolean' ||
    !Array.isArray(j.line) ||
    j.line.length < 2 ||
    !j.line.every(validCoord)
  ) {
    throw new Error('Invalid route')
  }
  return { fromName: j.fromName, toName: j.toName, trains: j.trains, line: j.line, approximate: j.approximate }
}
