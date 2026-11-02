import { contextBridge, ipcRenderer } from 'electron'
import type { Journey, NewJourney } from '../shared.ts'

const atlas = {
  list: (): Promise<Journey[]> => ipcRenderer.invoke('journeys:list'),
  add: (journey: NewJourney): Promise<void> => ipcRenderer.invoke('journeys:add', journey),
  remove: (id: number): Promise<void> => ipcRenderer.invoke('journeys:remove', id)
}

contextBridge.exposeInMainWorld('atlas', atlas)

export type Atlas = typeof atlas
