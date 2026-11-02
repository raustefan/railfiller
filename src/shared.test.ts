import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePolyline, distanceToLineM, journeyKey, lengthKm, parseNewJourney, type Coord } from './shared.ts'
import { sameTracks, serviceWindow, toConnections, toSegments, toStations } from './renderer/transitous.ts'

test('decodes polylines at both precisions', () => {
  const line = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)
  assert.deepEqual(line, [
    [-120.2, 38.5],
    [-120.95, 40.7],
    [-126.453, 43.252]
  ])
  // Real /plan response for India: precision 6, deltas beyond 32 bits.
  const india = decodePolyline('_iesu@krchrCretoEzcwpAbl{jBv_q[', 6)
  assert.ok(Math.abs(india[0][0] - 77.22) < 0.01 && Math.abs(india[0][1] - 28.64) < 0.01, String(india[0]))
  assert.ok(india.every(([lon, lat]) => lon > 72 && lon < 78 && lat > 18 && lat < 29), String(india))
})

test('measures distance and length', () => {
  const line: Coord[] = [
    [8, 47],
    [8, 48]
  ]
  assert.ok(Math.abs(lengthKm(line) - 111.2) < 0.5)
  assert.ok(Math.abs(distanceToLineM([8.01, 47.5], line) - 752) < 10)
  assert.ok(distanceToLineM([8, 47.5], line) < 1)
  // Beyond the end of the line, the end point is the nearest.
  assert.ok(Math.abs(distanceToLineM([8, 46.9], line) - 11119) < 20)
})

test('journey key ignores direction', () => {
  const line: Coord[] = [
    [8, 47],
    [8, 48]
  ]
  assert.equal(
    journeyKey({ fromName: 'A', toName: 'B', line }),
    journeyKey({ fromName: 'B', toName: 'A', line: [...line].reverse() })
  )
})

test('rejects malformed journeys', () => {
  const ok = { fromName: 'A', toName: 'B', trains: '', approximate: false, line: [[8, 47], [8, 48]] }
  assert.deepEqual(parseNewJourney(ok), ok)
  assert.throws(() => parseNewJourney(null))
  assert.throws(() => parseNewJourney({ ...ok, line: [[8, 47]] }))
  assert.throws(() => parseNewJourney({ ...ok, line: [[8, 47], [999, 48]] }))
  assert.throws(() => parseNewJourney({ ...ok, line: 'x' }))
})

test('removes duplicate stations between feeds', () => {
  const base = { lat: 47.378, lon: 8.54 }
  const stations = toStations([
    { ...base, id: 'a', name: 'Zürich HB', country: 'CH', areas: [{ name: 'Zürich', default: true }] },
    { ...base, id: 'b', name: 'Zürich HB' }
  ])
  assert.deepEqual(stations, [{ id: 'a', name: 'Zürich HB', area: 'Zürich, CH' }])
  assert.equal(toStations([{ ...base, id: 'd', name: 'NEW DELHI,  -' }])[0].name, 'NEW DELHI')
})

test('tells routes apart even when their lengths are close', () => {
  const a: Coord[] = [[8, 47], [8, 47.4], [8, 47.8]]
  assert.ok(sameTracks(a, [[8, 47], [8.001, 47.4], [8, 47.81]]))
  // Same length, but through a town 15 km away.
  assert.ok(!sameTracks(a, [[8, 47], [8.2, 47.4], [8, 47.8]]))
})

const leg = (name: string, points: string, stops = 0) => ({
  mode: 'LONG_DISTANCE',
  duration: 3600,
  from: { name: 'A' },
  to: { name: 'B' },
  displayName: name,
  intermediateStops: Array(stops),
  legGeometry: { points, precision: 5 }
})

test('groups trains on the same tracks, and flags paths without a track shape', () => {
  const shape = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'
  const connections = toConnections([
    { legs: [leg('IC 1', shape)] },
    { legs: [leg('IC 2', shape)] },
    { legs: [{ ...leg('walk', shape), mode: 'WALK' }, leg('IC 1', shape)] }
  ])
  assert.equal(connections.length, 1)
  assert.deepEqual(connections[0].trainNames, ['IC 1', 'IC 2'])
  assert.equal(connections[0].approximate, false)
  assert.equal(toConnections([{ legs: [leg('X', shape, 1)] }])[0].approximate, true)
  // Two transit legs would be a transfer, not a direct connection.
  assert.equal(toConnections([{ legs: [leg('A', shape), leg('B', shape)] }]).length, 0)
})

test('offers only rail stretches near the tap, shortest first', () => {
  const long = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'
  const short = '_p~iF~ps|U_ulLnnqC'
  const seg = (mode: string, from: string, to: string, polyline: string, displayName: string) => ({
    mode,
    from: { name: from },
    to: { name: to },
    polyline,
    trips: [{ displayName }]
  })
  const point: Coord = [-120.2, 38.5]
  const found = toSegments(
    [
      seg('AIRPLANE', 'X', 'Y', long, 'LH 1'),
      seg('LONG_DISTANCE', 'A', 'C', long, 'IC 1'),
      seg('REGIONAL_RAIL', 'A', 'B', short, 'RE 1'),
      seg('REGIONAL_RAIL', 'B', 'A', short, 'RE 2'),
      seg('REGIONAL_RAIL', 'P', 'Q', '_c`|@_c`|@_ulLnnqC', 'far away')
    ],
    point,
    100
  )
  assert.deepEqual(
    found.map((c) => [c.fromName, c.toName, c.trainNames]),
    [
      ['A', 'B', ['RE 1', 'RE 2']],
      ['A', 'C', ['IC 1']]
    ]
  )
})

test('service window is a future Wednesday morning at the given longitude', () => {
  const monday = new Date('2026-11-02T12:00:00Z')
  assert.equal(serviceWindow(0, monday).startTime, '2026-11-04T06:00:00.000Z')
  assert.equal(serviceWindow(135, monday).startTime, '2026-11-03T21:00:00.000Z')
  // On a Wednesday the window moves a full week ahead instead of possibly lying in the past.
  assert.equal(serviceWindow(0, new Date('2026-11-04T12:00:00Z')).startTime, '2026-11-11T06:00:00.000Z')
  assert.equal(serviceWindow(0, monday).endTime, '2026-11-04T14:00:00.000Z')
})
