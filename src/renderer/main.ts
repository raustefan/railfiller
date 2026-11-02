import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, LngLatBoundsLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import mapWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'
import './style.css'
import type { Atlas } from '../preload/index.ts'
import { journeyKey, lengthKm, type Coord, type Journey, type NewJourney } from '../shared.ts'
import { findDirectConnections, findSegmentsAt, searchStations, type Connection, type Station } from './transitous.ts'

declare global {
  interface Window {
    atlas: Atlas
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const ERROR_TEXT = "Can't reach the timetable service. Check your internet connection."
const ESTIMATED_TEXT = 'estimated route'
const VIEW_KEY = 'map-view'
const MENU_KEY = 'menu-open'
const MIN_TAP_ZOOM = 9
// See-through, so that stretches covered by several saved rides glow stronger.
const RIDE_OPACITY = 0.6
const TAP_RADIUS_PX = 16
const MAP_LAYERS = {
  'show-rides': ['journeys-casing', 'journeys', 'journeys-approximate'],
  'show-network': ['rail']
}

const LIGHT = {
  style: 'https://tiles.openfreemap.org/styles/positron',
  land: '#E4E9EC',
  water: '#C5D3DC',
  casing: '#FFFFFF',
  preview: '#123A63',
  roads: null,
  // Dark lines on a light map.
  railBrightness: { min: 0, max: 1 }
}
const DARK = {
  style: 'https://tiles.openfreemap.org/styles/dark',
  land: '#13263A',
  water: '#0B1826',
  casing: '#0B1826',
  preview: '#F5F7F8',
  // The style's near-black roads would otherwise read as rail lines.
  roads: '#233B52',
  // Swapping the two inverts the tiles, which are only drawn for light maps.
  railBrightness: { min: 1, max: 0 }
}
const darkMode = matchMedia('(prefers-color-scheme: dark)')
const theme = () => (darkMode.matches ? DARK : LIGHT)

const lineFeature = (line: Coord[], approximate = false) => ({
  type: 'Feature' as const,
  properties: { approximate },
  geometry: { type: 'LineString' as const, coordinates: line }
})
const featureCollection = (features: ReturnType<typeof lineFeature>[]) => ({ type: 'FeatureCollection' as const, features })

function boundsOf(lines: Coord[][]): LngLatBoundsLike {
  const bounds = new maplibregl.LngLatBounds()
  for (const line of lines) for (const coord of line) bounds.extend(coord)
  return bounds
}

// MapLibre cannot locate its worker from a file:// page, so it gets one from memory.
maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([mapWorker], { type: 'text/javascript' })))

const savedView = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null')
const map = new maplibregl.Map({
  container: 'map',
  style: theme().style,
  center: savedView?.center ?? [10, 30],
  zoom: savedView?.zoom ?? 2,
  attributionControl: false
})
// Their terms also rule out collapsed attribution.
map.addControl(
  new maplibregl.AttributionControl({
    compact: false,
    customAttribution: 'Timetable: <a href="https://transitous.org/sources/">Transitous</a>'
  })
)
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
map.on('moveend', () => {
  localStorage.setItem(VIEW_KEY, JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }))
})

let journeys: Journey[] = []
let previewLines: Coord[][] = []

const journeysData = () => featureCollection(journeys.map((j) => lineFeature(j.line, j.approximate)))
const previewData = () => featureCollection(previewLines.map((l) => lineFeature(l)))

function setPreview(lines: Coord[][]): void {
  previewLines = lines
  ;(map.getSource('preview') as GeoJSONSource | undefined)?.setData(previewData())
}

function fit(lines: Coord[][]): void {
  // The plate covers the left side, so the map centres in what stays visible.
  const left = $('plate').offsetWidth + 52
  map.fitBounds(boundsOf(lines), { padding: { top: 60, bottom: 60, left, right: 60 }, maxZoom: 13 })
}

function applyLayerToggles(): void {
  for (const [id, layers] of Object.entries(MAP_LAYERS)) {
    const visibility = $<HTMLInputElement>(id).checked ? 'visible' : 'none'
    for (const layer of layers) if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visibility)
  }
}

// Fires again after every style change, which drops everything added here.
map.on('style.load', () => {
  const { land, water, casing, preview, roads, railBrightness } = theme()
  const baseLayers = map.getStyle().layers
  const firstLabel = baseLayers.find((layer) => layer.type === 'symbol')?.id
  for (const { id, type } of baseLayers) {
    // OpenRailwayMap draws the network, so its switch must leave no rail behind.
    if (id.startsWith('railway')) map.setLayoutProperty(id, 'visibility', 'none')
    else if (roads && type === 'line' && /^(highway|road|aeroway)/.test(id)) map.setPaintProperty(id, 'line-color', roads)
  }
  if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', land)
  if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', water)

  map.addSource('rail', {
    type: 'raster',
    tiles: ['https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
    tileSize: 256,
    minzoom: 2,
    maxzoom: 19,
    attribution:
      'Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Style: <a href="https://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA 2.0</a> <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>'
  })
  // Grey network, so that only the ridden lines carry colour.
  map.addLayer(
    {
      id: 'rail',
      type: 'raster',
      source: 'rail',
      paint: {
        'raster-saturation': -0.9,
        'raster-opacity': 0.8,
        'raster-brightness-min': railBrightness.min,
        'raster-brightness-max': railBrightness.max
      }
    },
    firstLabel
  )

  map.addSource('journeys', { type: 'geojson', data: journeysData() })
  map.addSource('preview', { type: 'geojson', data: previewData() })
  const width = (base: number): maplibregl.ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 3, base, 12, base * 2]
  map.addLayer(
    { id: 'preview', type: 'line', source: 'preview', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': preview, 'line-width': width(3), 'line-opacity': 0.85 } },
    firstLabel
  )
  map.addLayer(
    { id: 'journeys-casing', type: 'line', source: 'journeys', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': casing, 'line-width': width(5) } },
    firstLabel
  )
  map.addLayer(
    { id: 'journeys', type: 'line', source: 'journeys', filter: ['!', ['get', 'approximate']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#EA580C', 'line-width': width(3), 'line-opacity': RIDE_OPACITY } },
    firstLabel
  )
  map.addLayer(
    { id: 'journeys-approximate', type: 'line', source: 'journeys', filter: ['get', 'approximate'], paint: { 'line-color': '#EA580C', 'line-width': width(3), 'line-opacity': RIDE_OPACITY, 'line-dasharray': [1.5, 1.5] } },
    firstLabel
  )
  applyLayerToggles()
})

darkMode.addEventListener('change', () => map.setStyle(theme().style, { diff: false }))

async function refreshJourneys(): Promise<void> {
  journeys = await window.atlas.list()
  ;(map.getSource('journeys') as GeoJSONSource | undefined)?.setData(journeysData())
  renderJourneys()
}

function renderJourneys(): void {
  $('count').textContent = journeys.length ? String(journeys.length) : ''
  $('empty').hidden = journeys.length > 0
  $('journeys').replaceChildren(
    ...journeys.map((j) => {
      const details = [j.trains, `${Math.round(lengthKm(j.line))} km`, j.approximate ? ESTIMATED_TEXT : ''].filter(Boolean).join(', ')
      return el(
        'li',
        {},
        el(
          'button',
          { className: 'journey', type: 'button', title: 'Show on map', onclick: () => fit([j.line]) },
          el('strong', {}, `${j.fromName} – ${j.toName}`),
          el('small', {}, details)
        ),
        el('button', {
          className: 'remove',
          type: 'button',
          textContent: '×',
          title: 'Remove from atlas',
          ariaLabel: `Remove ${j.fromName} – ${j.toName} from atlas`,
          onclick: async () => {
            if (!confirm(`Remove ${j.fromName} – ${j.toName} from your atlas?`)) return
            await window.atlas.remove(j.id)
            await refreshJourneys()
          }
        })
      )
    })
  )
}

function isSaved(c: NewJourney): boolean {
  const key = journeyKey(c)
  return journeys.some((j) => journeyKey(j) === key)
}

function connectionRow(c: Connection, title: string, facts: string[], afterAdd: () => void): HTMLLIElement {
  const button = el('button', { type: 'button', className: 'add' })
  const showState = () => {
    const saved = isSaved(c)
    button.textContent = saved ? 'In atlas' : 'Add'
    button.disabled = saved
  }
  showState()
  button.onclick = async () => {
    const { fromName, toName, trains, line, approximate } = c
    await window.atlas.add({ fromName, toName, trains, line, approximate })
    await refreshJourneys()
    setPreview([])
    showState()
    afterAdd()
  }
  const details = [...facts, `${Math.round(c.km)} km`, c.approximate ? ESTIMATED_TEXT : '']
  return el(
    'li',
    { className: 'connection', tabIndex: 0, onmouseenter: () => setPreview([c.line]), onfocus: () => setPreview([c.line]) },
    el('div', {}, el('strong', {}, title), el('small', {}, details.filter(Boolean).join(', '))),
    button
  )
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60)
  return hours ? `${hours} h ${total % 60} min` : `${total} min`
}

// Menu and layer switches

function setMenuOpen(open: boolean): void {
  const toggle = $('toggle-menu')
  const label = open ? 'Collapse menu' : 'Expand menu'
  $('plate-body').hidden = !open
  $('plate').classList.toggle('collapsed', !open)
  toggle.title = label
  toggle.setAttribute('aria-label', label)
  toggle.setAttribute('aria-expanded', String(open))
  localStorage.setItem(MENU_KEY, String(open))
}
setMenuOpen(localStorage.getItem(MENU_KEY) !== 'false')
$('toggle-menu').addEventListener('click', () => setMenuOpen($('plate').classList.contains('collapsed')))

for (const id of Object.keys(MAP_LAYERS)) {
  const checkbox = $<HTMLInputElement>(id)
  checkbox.checked = localStorage.getItem(id) !== 'false'
  checkbox.addEventListener('change', () => {
    localStorage.setItem(id, String(checkbox.checked))
    applyLayerToggles()
  })
}

// Station fields

const picked: { from: Station | null; to: Station | null } = { from: null, to: null }
let checkAbort: AbortController | null = null

function stationField(field: 'from' | 'to'): void {
  const input = $<HTMLInputElement>(field)
  const list = $<HTMLUListElement>(`${field}-options`)
  let options: Station[] = []
  let active = -1
  let abort: AbortController | null = null
  let timer: ReturnType<typeof setTimeout>

  const close = () => {
    list.hidden = true
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }
  const choose = (station: Station) => {
    picked[field] = station
    input.value = station.name
    close()
    void checkConnection()
  }
  const render = () => {
    list.replaceChildren(
      ...options.map((s, i) =>
        el(
          'li',
          {
            id: `${field}-option-${i}`,
            role: 'option',
            ariaSelected: String(i === active),
            // mousedown, because a click would come after the input's blur closed the list.
            onmousedown: (event: MouseEvent) => {
              event.preventDefault()
              choose(s)
            }
          },
          el('strong', {}, s.name),
          el('small', {}, s.area)
        )
      )
    )
    if (active >= 0) input.setAttribute('aria-activedescendant', `${field}-option-${active}`)
    else input.removeAttribute('aria-activedescendant')
  }
  const showMessage = (text: string) => {
    options = []
    input.setAttribute('aria-expanded', 'true')
    list.replaceChildren(el('li', { className: 'message' }, text))
    list.hidden = false
  }

  input.addEventListener('input', () => {
    picked[field] = null
    clearTimeout(timer)
    abort?.abort()
    const text = input.value.trim()
    if (text.length < 2) return close()
    timer = setTimeout(async () => {
      const current = (abort = new AbortController())
      try {
        options = await searchStations(text, current.signal)
      } catch {
        if (!current.signal.aborted) showMessage(ERROR_TEXT)
        return
      }
      active = options.length ? 0 : -1
      if (!options.length) return showMessage('No station found. Check the spelling.')
      render()
      list.hidden = false
      input.setAttribute('aria-expanded', 'true')
    }, 250)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return close()
    if (list.hidden || !options.length) {
      if (event.key === 'Enter') event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (active >= 0) choose(options[active])
    }
  })
  input.addEventListener('blur', close)
}

async function checkConnection(): Promise<void> {
  const { from, to } = picked
  const result = $('result')
  checkAbort?.abort()
  setPreview([])
  if (!from || !to) return result.replaceChildren()
  if (from.id === to.id) return result.replaceChildren(el('p', {}, 'From and To are the same station.'))

  const abort = (checkAbort = new AbortController())
  result.replaceChildren(el('p', {}, 'Checking the timetable…'))
  try {
    const connections = await findDirectConnections(from, to, abort.signal)
    if (!connections.length) {
      result.replaceChildren(
        el('h2', {}, 'No direct connection'),
        el('p', {}, `The timetable shows no train without a transfer from ${from.name} to ${to.name} in the next 7 days. Big cities often have several stations, so try the others too.`)
      )
      return
    }
    result.replaceChildren(
      el('h2', {}, connections.length === 1 ? 'Direct connection found' : `Direct connection on ${connections.length} routes`),
      el('ul', {}, ...connections.slice(0, 5).map((c) => connectionRow(c, c.trains || `${c.fromName} – ${c.toName}`, [formatMinutes(c.minutes)], () => {})))
    )
    setPreview(connections.map((c) => c.line))
    fit(connections.map((c) => c.line))
  } catch {
    if (abort.signal.aborted) return
    result.replaceChildren(
      el('p', {}, ERROR_TEXT),
      el('button', { type: 'button', className: 'add', textContent: 'Check again', onclick: () => void checkConnection() })
    )
  }
}

stationField('from')
stationField('to')
void refreshJourneys()
$('plate').querySelector('form')!.addEventListener('submit', (event) => event.preventDefault())

// Tapping a line

let tapAbort: AbortController | null = null
let tapPopup: maplibregl.Popup | null = null

function showTapPopup(lngLat: maplibregl.LngLat, content: HTMLElement): void {
  tapPopup?.remove()
  tapPopup = new maplibregl.Popup({ maxWidth: '340px', className: 'tap' }).setLngLat(lngLat).setDOMContent(content).addTo(map)
  tapPopup.on('close', () => setPreview([]))
}

map.on('click', async ({ lngLat }) => {
  tapAbort?.abort()
  if (map.getZoom() < MIN_TAP_ZOOM) {
    showTapPopup(lngLat, el('p', {}, 'Zoom in to tap a single route.'))
    return
  }
  const abort = (tapAbort = new AbortController())
  const point: Coord = [lngLat.lng, lngLat.lat]
  const metresPerPixel = (40_075_016 * Math.cos((lngLat.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom())
  showTapPopup(lngLat, el('p', {}, 'Looking for routes…'))
  try {
    const segments = await findSegmentsAt(point, Math.max(30, TAP_RADIUS_PX * metresPerPixel), abort.signal)
    if (!segments.length) {
      showTapPopup(
        lngLat,
        el('p', {}, 'No trains in the timetable here. Tap closer to the line, or search for the route with From and To.')
      )
      return
    }
    showTapPopup(
      lngLat,
      el(
        'div',
        {},
        el('h2', {}, 'Add a route'),
        el('ul', {}, ...segments.map((s) => connectionRow(s, `${s.fromName} – ${s.toName}`, [s.trains], () => tapPopup?.remove())))
      )
    )
    setPreview([segments[0].line])
  } catch {
    if (!abort.signal.aborted) showTapPopup(lngLat, el('p', {}, ERROR_TEXT))
  }
})
