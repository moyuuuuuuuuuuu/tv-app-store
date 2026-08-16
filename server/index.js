import express from 'express'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
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

function isCgbiPng(buffer) {
  return buffer.subarray(0, 128).includes(Buffer.from('CgBI'))
}

async function findFile(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const match = await findFile(fullPath, predicate)
      if (match) return match
    } else if (entry.isFile() && predicate(fullPath)) {
      return fullPath
    }
  }
  return ''
}

async function readPlist(plistPath, keys) {
  const script = [
    'import json, plistlib, sys',
    'with open(sys.argv[1], "rb") as f: p = plistlib.load(f)',
    `keys = ${JSON.stringify(keys)}`,
    'print(json.dumps({k: p.get(k, "") for k in keys}, ensure_ascii=False))',
  ].join('\n')
  const { stdout } = await execFileAsync('python3', ['-c', script, plistPath])
  return JSON.parse(stdout)
}

function parseMachOArchitectures(buffer) {
  if (buffer.length < 8) return []
  const magic = buffer.readUInt32BE(0)
  const thinArchitectures = new Map([
    [0xfeedface, { endian: 'BE', offset: 4 }],
    [0xcefaedfe, { endian: 'LE', offset: 4 }],
    [0xfeedfacf, { endian: 'BE', offset: 4 }],
    [0xcffaedfe, { endian: 'LE', offset: 4 }],
  ])
  const cpuName = (cpuType) => {
    const normalized = cpuType >>> 0
    if (normalized === 0x01000007) return 'x86_64'
    if (normalized === 0x0100000c) return 'arm64'
    return ''
  }

  if (thinArchitectures.has(magic)) {
    const { endian, offset } = thinArchitectures.get(magic)
    const cpuType = endian === 'BE' ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset)
    return [cpuName(cpuType)].filter(Boolean)
  }

  const fatEndian = magic === 0xcafebabe || magic === 0xcafebabf ? 'BE'
    : magic === 0xbebafeca || magic === 0xbfbafeca ? 'LE' : ''
  if (!fatEndian) return []
  const readUInt32 = fatEndian === 'BE' ? Buffer.prototype.readUInt32BE : Buffer.prototype.readUInt32LE
  const count = readUInt32.call(buffer, 4)
  const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20
  const architectures = []
  for (let index = 0; index < count && 8 + index * stride + 4 <= buffer.length; index += 1) {
    const name = cpuName(readUInt32.call(buffer, 8 + index * stride))
    if (name && !architectures.includes(name)) architectures.push(name)
  }
  return architectures
}

async function withDmgContents(fullPath, callback) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dmg-info-'))
  let contentRoot = temporaryDirectory
  let mountedDevice = ''
  try {
    if (process.platform === 'darwin') {
      const mountPoint = path.join(temporaryDirectory, 'volume')
      const { stdout } = await execFileAsync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, fullPath])
      mountedDevice = stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).find((device) => /^\/dev\/disk\d+$/.test(device)) || ''
      contentRoot = mountPoint
    } else {
      await execFileAsync('7z', ['x', '-y', `-o${temporaryDirectory}`, fullPath], { maxBuffer: 8 * 1024 * 1024 })
    }

    return await callback(contentRoot, temporaryDirectory)
  } finally {
    if (mountedDevice) await execFileAsync('hdiutil', ['detach', mountedDevice]).catch(() => {})
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function inspectDmg(fullPath) {
  return withDmgContents(fullPath, async (contentRoot) => {
    const infoPath = await findFile(contentRoot, (filePath) => /\.app\/Contents\/Info\.plist$/i.test(filePath))
    if (!infoPath) return { info: {}, architectures: [], iconPath: '' }
    const info = await readPlist(infoPath, [
      'CFBundleDisplayName', 'CFBundleName', 'CFBundleIdentifier', 'CFBundleShortVersionString',
      'CFBundleVersion', 'LSMinimumSystemVersion', 'CFBundleExecutable', 'CFBundleIconFile',
    ])
    const executablePath = path.join(path.dirname(infoPath), 'MacOS', info.CFBundleExecutable || '')
    let architectures = []
    if (info.CFBundleExecutable) {
      const executable = await readFile(executablePath)
      architectures = parseMachOArchitectures(executable.subarray(0, 4096))
    }
    const resourcesPath = path.join(path.dirname(infoPath), 'Resources')
    const declaredIcon = info.CFBundleIconFile
      ? path.join(resourcesPath, /\.[^.]+$/.test(info.CFBundleIconFile) ? info.CFBundleIconFile : `${info.CFBundleIconFile}.icns`)
      : ''
    let iconFile = declaredIcon && await stat(declaredIcon).then(() => declaredIcon).catch(() => '')
    if (!iconFile) iconFile = await findFile(resourcesPath, (filePath) => /\.icns$/i.test(filePath)).catch(() => '')
    const iconPath = iconFile ? path.relative(contentRoot, iconFile) : ''
    return { info, architectures, iconPath }
  })
}

async function renderDmgIcon(fullPath, iconPath, outputPath) {
  return withDmgContents(fullPath, async (contentRoot) => {
    const sourcePath = path.join(contentRoot, iconPath)
    if (process.platform === 'darwin') {
      await execFileAsync('sips', ['-s', 'format', 'png', sourcePath, '--out', outputPath])
    } else {
      await execFileAsync('convert', [`${sourcePath}[0]`, outputPath])
    }
  })
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
    platform: 'android',
    platformLabel: 'Android',
  }
}

async function parseIpa(fileName) {
  const fullPath = path.join(apkDirectory, fileName)
  const fileStat = await stat(fullPath)
  const { stdout: fileList } = await execFileAsync('unzip', ['-Z1', fullPath], { maxBuffer: 8 * 1024 * 1024 })
  const entries = fileList.split('\n').map((entry) => entry.trim()).filter(Boolean)
  const infoPath = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/i.test(entry))
  let info = {}

  if (infoPath) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ipa-info-'))
    try {
      await execFileAsync('unzip', ['-j', fullPath, infoPath, '-d', directory])
      const plistPath = path.join(directory, path.basename(infoPath))
      const script = [
        'import json, plistlib, sys',
        'with open(sys.argv[1], "rb") as f: p = plistlib.load(f)',
        'keys = ["CFBundleDisplayName", "CFBundleName", "CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "MinimumOSVersion"]',
        'print(json.dumps({k: p.get(k, "") for k in keys}, ensure_ascii=False))',
      ].join('\n')
      const { stdout } = await execFileAsync('python3', ['-c', script, plistPath])
      info = JSON.parse(stdout)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  const appRoot = infoPath?.slice(0, infoPath.lastIndexOf('/') + 1) || ''
  const iconCandidates = entries.filter((entry) =>
    entry.startsWith(appRoot) && !entry.slice(appRoot.length).includes('/') && /(?:appicon|icon).*\.png$/i.test(entry),
  )
  const iconPath = iconCandidates.sort((a, b) => iconScore(b, ['appicon']) - iconScore(a, ['appicon']))[0] || ''

  return {
    id: Buffer.from(fileName).toString('base64url'),
    name: info.CFBundleDisplayName || info.CFBundleName || path.basename(fileName, path.extname(fileName)),
    packageName: info.CFBundleIdentifier || '',
    versionCode: info.CFBundleVersion || '',
    versionName: info.CFBundleShortVersionString || '',
    minSdk: info.MinimumOSVersion || '',
    targetSdk: '',
    fileName,
    fullPath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    iconPath,
    hasIcon: Boolean(iconPath),
    platform: 'ios',
    platformLabel: 'iOS',
  }
}

async function parseDmg(fileName) {
  const fullPath = path.join(apkDirectory, fileName)
  const fileStat = await stat(fullPath)
  const { info, architectures, iconPath } = await inspectDmg(fullPath)
  const architectureLabel = architectures.includes('arm64') && architectures.includes('x86_64')
    ? '通用（Intel + Apple 芯片）'
    : architectures.includes('arm64') ? 'Apple 芯片'
      : architectures.includes('x86_64') ? 'Intel' : ''
  return {
    id: Buffer.from(fileName).toString('base64url'),
    name: info.CFBundleDisplayName || info.CFBundleName || path.basename(fileName, path.extname(fileName)),
    packageName: info.CFBundleIdentifier || '',
    versionCode: info.CFBundleVersion || '',
    versionName: info.CFBundleShortVersionString || '',
    minSdk: info.LSMinimumSystemVersion || '',
    targetSdk: '',
    architectures,
    architectureLabel,
    fileName,
    fullPath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    iconPath,
    hasIcon: Boolean(iconPath),
    platform: 'macos',
    platformLabel: 'macOS',
  }
}

function parsePackage(fileName) {
  const extension = path.extname(fileName).toLowerCase()
  if (extension === '.apk') return parseApk(fileName)
  if (extension === '.ipa') return parseIpa(fileName)
  return parseDmg(fileName)
}

async function scan() {
  const entries = await readdir(apkDirectory, { withFileTypes: true })
  const packageFiles = entries
    .filter((entry) => entry.isFile() && /\.(?:apk|ipa|dmg)$/i.test(entry.name))
    .map((entry) => entry.name)
  const results = await Promise.allSettled(packageFiles.map(parsePackage))
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
      if (item.platform === 'macos') {
        const convertedFile = path.join(directory, 'icon.png')
        await renderDmgIcon(item.fullPath, item.iconPath, convertedFile)
        response.type('image/png')
        response.set('Cache-Control', 'public, max-age=3600')
        response.send(await readFile(convertedFile))
        return
      }
      await execFileAsync('unzip', ['-j', item.fullPath, item.iconPath, '-d', directory])
      const iconFile = path.join(directory, path.basename(item.iconPath))
      const extension = path.extname(iconFile).toLowerCase()
      let responseFile = iconFile

      // iOS stores many app icons as CgBI PNGs. Browsers cannot decode these
      // directly, so restore them to regular PNG before sending the response.
      if (item.platform === 'ios' && extension === '.png') {
        const originalIcon = await readFile(iconFile)
        const convertedFile = path.join(directory, `converted-${path.basename(iconFile)}`)
        if (isCgbiPng(originalIcon)) {
          await execFileAsync('pngcrush', ['-q', '-revert-iphone-optimizations', iconFile, convertedFile])
          const convertedIcon = await readFile(convertedFile)
          if (isCgbiPng(convertedIcon)) throw new Error('CgBI icon conversion did not produce a browser-compatible PNG')
          responseFile = convertedFile
        }
      }

      response.type(extension === '.webp' ? 'image/webp' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png')
      response.set('Cache-Control', 'public, max-age=3600')
      response.send(await readFile(responseFile))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn(`Unable to extract icon for ${request.params.id}: ${error.message}`)
    if (!response.headersSent) response.sendStatus(404)
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
