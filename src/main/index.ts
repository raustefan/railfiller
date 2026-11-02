import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { journeyKey, parseNewJourney, type Journey } from '../shared.ts'

// OpenRailwayMap and Transitous both require a User-Agent that identifies the app.
app.userAgentFallback = `railfiller/${app.getVersion()} (https://github.com/raustefan/railfiller)`

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(join(app.getPath('userData'), 'railfiller.sqlite'))
  db.exec(`CREATE TABLE IF NOT EXISTS journeys (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    from_name TEXT NOT NULL,
    to_name TEXT NOT NULL,
    trains TEXT NOT NULL,
    line TEXT NOT NULL,
    approximate INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  return db
}

function registerDatabaseHandlers(db: DatabaseSync): void {
  const list = db.prepare('SELECT * FROM journeys ORDER BY id DESC')
  const add = db.prepare(
    'INSERT OR IGNORE INTO journeys (key, from_name, to_name, trains, line, approximate) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const remove = db.prepare('DELETE FROM journeys WHERE id = ?')

  ipcMain.handle('journeys:list', (): Journey[] =>
    list.all().map((row) => ({
      id: Number(row.id),
      fromName: String(row.from_name),
      toName: String(row.to_name),
      trains: String(row.trains),
      line: JSON.parse(String(row.line)),
      approximate: row.approximate === 1
    }))
  )
  ipcMain.handle('journeys:add', (_event, value: unknown) => {
    const j = parseNewJourney(value)
    add.run(journeyKey(j), j.fromName, j.toName, j.trains, JSON.stringify(j.line), j.approximate ? 1 : 0)
  })
  ipcMain.handle('journeys:remove', (_event, id: unknown) => {
    if (typeof id !== 'number') throw new Error('Invalid ID')
    remove.run(id)
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 24, y: 25 },
    // Matches the map, so the window doesn't flash before it has loaded.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#13263A' : '#E4E9EC',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
  })

  // Attribution links open in the browser; the app window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerDatabaseHandlers(openDatabase())
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
