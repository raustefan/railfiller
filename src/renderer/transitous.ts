import { decodePolyline, distanceToLineM, lengthKm, type Coord, type NewJourney } from '../shared.ts'

const API = 'https://api.transitous.org/api'
const RAIL_MODES = ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_RAIL', 'SUBURBAN']
const DAY_MS = 86_400_000

export interface Station {
  id: string
  name: string
  area: string
}

export interface Connection extends NewJourney {
  km: number
  minutes: number
  trainNames: string[]
}

export class ServiceError extends Error {}

async function get<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const timeout = AbortSignal.timeout(30_000)
  const response = await fetch(`${API}${path}?${query}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new ServiceError(`Transitous responded with status ${response.status}`)
  return response.json()
}

interface GeocodeMatch {
  id: string
  name: string
  lat: number
  lon: number
  country?: string
  areas?: { name: string; default?: boolean }[]
}

export function toStations(matches: GeocodeMatch[]): Station[] {
  const seen = new Set<string>()
  const stations: Station[] = []
  for (const m of matches) {
    // Several timetable feeds list the same station.
    const key = `${m.name.toLowerCase()}|${m.lat.toFixed(2)}|${m.lon.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    const town = m.areas?.find((a) => a.default)?.name
    // The Indian feed appends an empty field to its names.
    stations.push({ id: m.id, name: m.name.replace(/,\s*-$/, ''), area: [town, m.country].filter(Boolean).join(', ') })
  }
  return stations
}

export async function searchStations(text: string, signal: AbortSignal): Promise<Station[]> {
  return toStations(await get<GeocodeMatch[]>('/v1/geocode', { text, type: 'STOP', mode: RAIL_MODES.join(','), language: 'en' }, signal))
}

interface Leg {
  mode: string
  duration: number
  from: { name: string }
  to: { name: string }
  displayName?: string
  routeShortName?: string
  intermediateStops?: unknown[]
  legGeometry: { points: string; precision: number }
}

function namesText(names: string[]): string {
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '')
}

// Shapes of trains on the same tracks differ slightly, so exact geometry cannot identify a route.
export function sameTracks(a: Coord[], b: Coord[]): boolean {
  const middle = (line: Coord[]) => line[Math.floor(line.length / 2)]
  return Math.abs(lengthKm(a) - lengthKm(b)) < 3 && lengthKm([middle(a), middle(b)]) < 3
}

// Trains on the same tracks collapse into one row.
export function toConnections(itineraries: { legs: Leg[] }[]): Connection[] {
  const groups: Connection[] = []
  for (const { legs } of itineraries) {
    const transit = legs.filter((l) => l.mode !== 'WALK')
    if (transit.length !== 1) continue
    const leg = transit[0]
    const line = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision)
    if (line.length < 2) continue
    const name = leg.displayName || leg.routeShortName || ''
    const minutes = Math.round(leg.duration / 60)
    const group = groups.find((g) => sameTracks(g.line, line))
    if (group) {
      if (name && !group.trainNames.includes(name)) group.trainNames.push(name)
      group.minutes = Math.min(group.minutes, minutes)
      group.trains = namesText(group.trainNames)
      continue
    }
    groups.push({
      fromName: leg.from.name,
      toName: leg.to.name,
      trainNames: name ? [name] : [],
      trains: name,
      line,
      km: lengthKm(line),
      minutes,
      // Without a track shape the path only connects the stops.
      approximate: line.length <= (leg.intermediateStops?.length ?? 0) + 2
    })
  }
  return groups.sort((a, b) => a.minutes - b.minutes)
}

// The API allows a 24-hour window per request, so weekly trains need one request per day.
export async function findDirectConnections(from: Station, to: Station, signal: AbortSignal): Promise<Connection[]> {
  const start = Date.now()
  for (let day = 0; day < 7; day++) {
    const { itineraries } = await get<{ itineraries: { legs: Leg[] }[] }>(
      '/v5/plan',
      {
        fromPlace: from.id,
        toPlace: to.id,
        time: new Date(start + day * DAY_MS).toISOString(),
        searchWindow: DAY_MS / 1000,
        maxTransfers: 0,
        transitModes: RAIL_MODES.join(','),
        directModes: '',
        maxPreTransitTime: 600,
        maxPostTransitTime: 600
      },
      signal
    )
    const connections = toConnections(itineraries)
    if (connections.length) return connections
  }
  return []
}

// Next Wednesday, 06:00 at the tapped longitude: a normal working day in every timetable.
export function serviceWindow(lon: number, now: Date): { startTime: string; endTime: string } {
  const daysAhead = ((3 - now.getUTCDay() + 7) % 7) || 7
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead, 6) - (lon / 15) * 3_600_000
  return { startTime: new Date(start).toISOString(), endTime: new Date(start + DAY_MS / 3).toISOString() }
}

interface TripSegment {
  mode: string
  from: { name: string }
  to: { name: string }
  polyline: string
  trips: { displayName?: string }[]
}

// One candidate per stretch between two stops, shortest first: the tapped section itself.
export function toSegments(segments: TripSegment[], point: Coord, toleranceM: number): Connection[] {
  const groups = new Map<string, Connection>()
  for (const s of segments) {
    if (!RAIL_MODES.includes(s.mode) || s.from.name === s.to.name) continue
    const key = [s.from.name, s.to.name].sort().join('|')
    const name = s.trips[0]?.displayName ?? ''
    const group = groups.get(key)
    if (group) {
      if (name && !group.trainNames.includes(name)) {
        group.trainNames.push(name)
        group.trains = namesText(group.trainNames)
      }
      continue
    }
    const line = decodePolyline(s.polyline, 5)
    if (line.length < 2 || distanceToLineM(point, line) > toleranceM) continue
    groups.set(key, {
      fromName: s.from.name,
      toName: s.to.name,
      trainNames: name ? [name] : [],
      trains: name,
      line,
      km: lengthKm(line),
      minutes: 0,
      approximate: line.length <= 2
    })
  }
  return [...groups.values()].sort((a, b) => a.km - b.km).slice(0, 8)
}

export async function findSegmentsAt(point: Coord, toleranceM: number, signal: AbortSignal): Promise<Connection[]> {
  const [lon, lat] = point
  const dLat = toleranceM / 111_000
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.05)
  const segments = await get<TripSegment[]>(
    '/v5/map/trips',
    {
      min: `${lat - dLat},${lon - dLon}`,
      max: `${lat + dLat},${lon + dLon}`,
      zoom: 14,
      ...serviceWindow(lon, new Date())
    },
    signal
  )
  return toSegments(segments, point, toleranceM)
}
