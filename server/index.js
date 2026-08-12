import express from 'express'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const app = express()
const port = Number(process.env.PORT || 3000)
const apkDirectory = path.resolve(process.env.APK_DIR || '/apks')
const aapt = process.env.AAPT_PATH || 'aapt'
let cache = new Map()

function value(line, key) {
  return line?.match(new RegExp(`${key}(?:=|:)\\s*'([^']*)'`))?.[1] || ''
}

function isRasterIcon(filePath) {
  return /\.(?:png|webp|jpe?g)$/i.test(filePath)
}

function iconScore(filePath, preferredNames) {
  const normalized = filePath.toLowerCase()
  const name = path.basename(normalized, path.extname(normalized))
  let score = preferredNames.includes(name) ? 1000 : 0
  if (/mipmap/.test(normalized)) score += 100
  if (/xxxhdpi/.test(normalized)) score += 60
  else if (/xxhdpi/.test(normalized)) score += 50
  else if (/xhdpi/.test(normalized)) score += 40
  else if (/hdpi/.test(normalized)) score += 30
  else if (/mdpi/.test(normalized)) score += 20
  if (/launcher|app_icon|icon/.test(name)) score += 10
  return score
}

async function resolveIcon(fullPath, declaredIcons) {
  const rasterDeclared = declaredIcons.filter(isRasterIcon)
  if (rasterDeclared.length) return rasterDeclared.at(-1)

  const preferredNames = declaredIcons.map((icon) => path.basename(icon, path.extname(icon)).toLowerCase())
  const { stdout } = await execFileAsync('unzip', ['-Z1', fullPath], { maxBuffer: 8 * 1024 * 1024 })
  const rasterFiles = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => /^res\//.test(entry) && isRasterIcon(entry))
    .filter((entry) => {
      const name = path.basename(entry, path.extname(entry)).toLowerCase()
      return preferredNames.includes(name) || /launcher|app_icon/.test(name)
    })

  return rasterFiles.sort((a, b) => iconScore(b, preferredNames) - iconScore(a, preferredNames))[0] || ''
}

async function parseApk(fileName) {
  const fullPath = path.join(apkDirectory, fileName)
  const fileStat = await stat(fullPath)
  const { stdout } = await execFileAsync(aapt, ['dump', 'badging', fullPath], { maxBuffer: 4 * 1024 * 1024 })
  const lines = stdout.split('\n')
  const packageLine = lines.find((line) => line.startsWith('package:'))
  const appLine = lines.find((line) => line.startsWith('application-label:'))
  const localizedAppLine = lines.find((line) => line.startsWith("application-label-zh:"))
  const iconLines = lines.filter((line) => /^application-icon-|^application:/.test(line))
  const iconCandidates = iconLines.flatMap((line) => {
    const attributeIcon = value(line, 'icon')
    const densityIcon = line.match(/^application-icon-[^:]+:\s*'([^']+)'/)?.[1]
    return [attributeIcon, densityIcon].filter(Boolean)
  })
  const id = Buffer.from(fileName).toString('base64url')

  const iconPath = await resolveIcon(fullPath, iconCandidates)

  return {
    id,
    name: value(localizedAppLine, 'application-label-zh') || value(appLine, 'application-label') || path.basename(fileName, path.extname(fileName)),
    packageName: value(packageLine, 'name'),
    versionCode: value(packageLine, 'versionCode'),
    versionName: value(packageLine, 'versionName'),
    minSdk: value(lines.find((line) => line.startsWith('sdkVersion:')), 'sdkVersion'),
    targetSdk: value(lines.find((line) => line.startsWith('targetSdkVersion:')), 'targetSdkVersion'),
    fileName,
    fullPath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    iconPath,
    hasIcon: Boolean(iconPath),
  }
}

async function scan() {
  const entries = await readdir(apkDirectory, { withFileTypes: true })
  const apkFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.apk')).map((entry) => entry.name)
  const results = await Promise.allSettled(apkFiles.map(parseApk))
  const parsed = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  cache = new Map(parsed.map((item) => [item.id, item]))
  return parsed.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

app.get('/api/health', (_request, response) => response.json({ status: 'ok', apkDirectory }))
app.get('/api/apps', async (_request, response) => {
  try {
    const apps = await scan()
    response.json({ apps: apps.map(({ fullPath, iconPath, ...item }) => item) })
  } catch (error) {
    response.status(error.code === 'ENOENT' ? 404 : 500).json({ error: error.message })
  }
})

app.get('/api/apps/:id/icon', async (request, response) => {
  try {
    let item = cache.get(request.params.id)
    if (!item) {
      await scan()
      item = cache.get(request.params.id)
    }
    if (!item?.iconPath) return response.sendStatus(404)
    const directory = await mkdtemp(path.join(tmpdir(), 'apk-icon-'))
    try {
      await execFileAsync('unzip', ['-j', item.fullPath, item.iconPath, '-d', directory])
      const iconFile = path.join(directory, path.basename(item.iconPath))
      const extension = path.extname(iconFile).toLowerCase()
      response.type(extension === '.webp' ? 'image/webp' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png')
      response.set('Cache-Control', 'public, max-age=3600')
      createReadStream(iconFile).on('close', () => rm(directory, { recursive: true, force: true })).pipe(response)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  } catch {
    response.sendStatus(404)
  }
})

app.get('/api/apps/:id/download', async (request, response) => {
  try {
    let item = cache.get(request.params.id)
    if (!item) {
      await scan()
      item = cache.get(request.params.id)
    }
    if (!item) return response.sendStatus(404)

    response.download(item.fullPath, item.fileName, (error) => {
      if (error && !response.headersSent) response.sendStatus(404)
    })
  } catch {
    response.sendStatus(404)
  }
})

app.use(express.static('dist'))
app.get('/*path', (_request, response) => response.sendFile(path.resolve('dist/index.html')))
app.listen(port, '0.0.0.0', () => console.log(`TV App Store listening on http://0.0.0.0:${port}; APK_DIR=${apkDirectory}`))
