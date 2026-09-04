import express from 'express'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const AppInfoParser = require('app-info-parser')
const app = express()
const port = Number(process.env.PORT || 3000)
const packageDirectory = path.resolve(process.env.PACKAGE_DIR || process.env.APK_DIR || '/packages')
const iconCacheDirectory = path.resolve(process.env.ICON_CACHE_DIR || '/app/data/icons')
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

function packageId(fileName) {
  return Buffer.from(fileName).toString('base64url')
}

function architectureDetails(architectures, platform) {
  const normalized = [...new Set(architectures.map((item) => item.toLowerCase()))]
  const has64 = normalized.some((item) => /64|arm64|aarch64/.test(item))
  const has32 = normalized.some((item) => /^(?:x86|armeabi(?:-v7a)?|armv7|arm|i[3-6]86|universal-32)$/.test(item))
  let label = '架构未知'
  if (platform === 'macos') {
    const intel = normalized.some((item) => /x86_64|amd64/.test(item))
    const apple = normalized.some((item) => /arm64|aarch64/.test(item))
    label = intel && apple ? 'Intel + M 系列' : apple ? 'M 系列' : intel ? 'Intel' : '架构未知'
  } else if (has32 && has64) label = '32 位 + 64 位'
  else if (has64) label = '64 位'
  else if (has32) label = '32 位'
  return { architectures: normalized, architectureLabel: label }
}

async function cachedIconPath(item, extractIcon) {
  if (!item.iconPath) return ''
  await mkdir(iconCacheDirectory, { recursive: true })
  const fingerprint = createHash('sha256')
    .update(`${item.fileName}:${item.size}:${item.modifiedAt}:${item.iconPath}`)
    .digest('hex').slice(0, 24)
  const outputPath = path.join(iconCacheDirectory, `${fingerprint}.png`)
  if (await stat(outputPath).then(() => true).catch(() => false)) return outputPath
  const temporaryPath = `${outputPath}.${process.pid}.tmp.png`
  try {
    await extractIcon(temporaryPath)
    await copyFile(temporaryPath, outputPath)
    return outputPath
  } catch (error) {
    console.warn(`Unable to cache icon for ${item.fileName}: ${error.message}`)
    return ''
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function cacheBase64Icon(item, dataUri) {
  if (!dataUri) return ''
  return cachedIconPath({ ...item, iconPath: 'embedded-base64' }, async (outputPath) => {
    const base64 = dataUri.replace(/^data:image\/[^;]+;base64,/, '')
    const sourcePath = `${outputPath}.source`
    try {
      await writeFile(sourcePath, Buffer.from(base64, 'base64'))
      await execFileAsync('convert', [sourcePath, outputPath])
    } finally {
      await rm(sourcePath, { force: true })
    }
  })
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

async function findFiles(directory, predicate, matches = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) await findFiles(fullPath, predicate, matches)
    else if (entry.isFile() && predicate(fullPath)) matches.push(fullPath)
  }
  return matches
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
  const { stdout } = await execFileAsync('unzip', ['-Z1', fullPath], { maxBuffer: 32 * 1024 * 1024 })
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

async function readApkBadging(fullPath) {
  try {
    return (await execFileAsync(aapt, ['dump', 'badging', fullPath], { maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (firstError) {
    try {
      return (await execFileAsync('aapt2', ['dump', 'badging', fullPath], { maxBuffer: 16 * 1024 * 1024 })).stdout
    } catch {
      throw firstError
    }
  }
}

async function parseApk(fileName) {
  const fullPath = path.join(packageDirectory, fileName)
  const fileStat = await stat(fullPath)
  let stdout = ''
  let parsedInfo = {}
  try { stdout = await readApkBadging(fullPath) }
  catch (error) {
    console.warn(`aapt could not parse ${fileName}, using built-in manifest parser: ${error.message}`)
    parsedInfo = await new AppInfoParser(fullPath).parse()
  }
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
  const nativeCodeLine = lines.find((line) => line.startsWith('native-code:')) || ''
  let architectures = [...nativeCodeLine.matchAll(/'([^']+)'/g)].map((match) => match[1])
  const id = packageId(fileName)

  let iconPath = ''
  try { iconPath = await resolveIcon(fullPath, iconCandidates) }
  catch (error) { console.warn(`Unable to locate APK icon for ${fileName}: ${error.message}`) }
  if (!architectures.length) {
    try {
      const { stdout: fileList } = await execFileAsync('unzip', ['-Z1', fullPath], { maxBuffer: 32 * 1024 * 1024 })
      architectures = [...new Set([...fileList.matchAll(/(?:^|\n)lib\/([^/]+)\//g)].map((match) => match[1]))]
    } catch { /* no native libraries means the APK is architecture-independent */ }
  }

  const item = {
    id,
    name: value(localizedAppLine, 'application-label-zh') || value(appLine, 'application-label') || parsedInfo.application?.label || path.basename(fileName, path.extname(fileName)),
    packageName: value(packageLine, 'name') || parsedInfo.package || '',
    versionCode: value(packageLine, 'versionCode') || parsedInfo.versionCode || '',
    versionName: value(packageLine, 'versionName') || parsedInfo.versionName || '',
    minSdk: value(lines.find((line) => line.startsWith('sdkVersion:')), 'sdkVersion') || parsedInfo.usesSdk?.minSdkVersion || '',
    targetSdk: value(lines.find((line) => line.startsWith('targetSdkVersion:')), 'targetSdkVersion') || parsedInfo.usesSdk?.targetSdkVersion || '',
    fileName,
    fullPath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    iconPath,
    platform: 'android',
    platformLabel: 'Android',
    ...architectureDetails(architectures.length ? architectures : ['universal-32', 'universal-64'], 'android'),
  }
  item.cachedIconPath = await cacheBase64Icon(item, parsedInfo.icon) || await cachedIconPath(item, async (outputPath) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'apk-icon-'))
    try {
      await execFileAsync('unzip', ['-j', fullPath, iconPath, '-d', directory])
      await execFileAsync('convert', [path.join(directory, path.basename(iconPath)), outputPath])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  item.hasIcon = Boolean(item.cachedIconPath)
  return item
}

async function parseIpa(fileName) {
  const fullPath = path.join(packageDirectory, fileName)
  const fileStat = await stat(fullPath)
  const { stdout: fileList } = await execFileAsync('unzip', ['-Z1', fullPath], { maxBuffer: 32 * 1024 * 1024 })
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
        'keys = ["CFBundleDisplayName", "CFBundleName", "CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "MinimumOSVersion", "CFBundleExecutable"]',
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

  const executablePath = info.CFBundleExecutable ? `${appRoot}${info.CFBundleExecutable}` : ''
  let architectures = []
  if (executablePath) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ipa-bin-'))
    try {
      await execFileAsync('unzip', ['-j', fullPath, executablePath, '-d', directory])
      architectures = parseMachOArchitectures((await readFile(path.join(directory, path.basename(executablePath)))).subarray(0, 4096))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  const item = {
    id: packageId(fileName),
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
    platform: 'ios',
    platformLabel: 'iOS',
    ...architectureDetails(architectures, 'ios'),
  }
  item.cachedIconPath = await cachedIconPath(item, async (outputPath) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ipa-icon-'))
    try {
      await execFileAsync('unzip', ['-j', fullPath, iconPath, '-d', directory])
      const source = path.join(directory, path.basename(iconPath))
      if (isCgbiPng(await readFile(source))) await execFileAsync('pngcrush', ['-q', '-revert-iphone-optimizations', source, outputPath])
      else await execFileAsync('convert', [source, outputPath])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  item.hasIcon = Boolean(item.cachedIconPath)
  return item
}

async function parseDmg(fileName) {
  const fullPath = path.join(packageDirectory, fileName)
  const fileStat = await stat(fullPath)
  const { info, architectures, iconPath } = await inspectDmg(fullPath)
  const item = {
    id: packageId(fileName),
    name: info.CFBundleDisplayName || info.CFBundleName || path.basename(fileName, path.extname(fileName)),
    packageName: info.CFBundleIdentifier || '',
    versionCode: info.CFBundleVersion || '',
    versionName: info.CFBundleShortVersionString || '',
    minSdk: info.LSMinimumSystemVersion || '',
    targetSdk: '',
    ...architectureDetails(architectures, 'macos'),
    fileName,
    fullPath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    iconPath,
    platform: 'macos',
    platformLabel: 'macOS',
  }
  item.cachedIconPath = await cachedIconPath(item, (outputPath) => renderDmgIcon(fullPath, iconPath, outputPath))
  item.hasIcon = Boolean(item.cachedIconPath)
  return item
}

function parsePeArchitecture(buffer) {
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') return []
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 6 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return []
  return ({ 0x014c: ['x86'], 0x8664: ['x86_64'], 0x01c0: ['arm'], 0xaa64: ['arm64'] })[buffer.readUInt16LE(peOffset + 4)] || []
}

function parsePeMinimumWindows(buffer) {
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') return ''
  const peOffset = buffer.readUInt32LE(0x3c)
  const optionalHeader = peOffset + 24
  if (optionalHeader + 44 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return ''
  const version = `${buffer.readUInt16LE(optionalHeader + 40)}.${buffer.readUInt16LE(optionalHeader + 42)}`
  return ({ '5.0': '2000', '5.1': 'XP', '5.2': 'XP x64', '6.0': 'Vista', '6.1': '7', '6.2': '8', '6.3': '8.1', '10.0': '10' })[version]
    || (version !== '0.0' ? `NT ${version}` : '')
}

async function readWindowsVersionInfo(fullPath) {
  try {
    const { stdout } = await execFileAsync('exiftool', ['-json', '-ProductName', '-FileDescription', '-ProductVersion', '-FileVersion', fullPath], { maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(stdout)[0] || {}
  } catch { return {} }
}

async function readMsiProperties(fullPath) {
  try {
    const { stdout } = await execFileAsync('msiinfo', ['export', fullPath, 'Property'], { maxBuffer: 4 * 1024 * 1024 })
    return Object.fromEntries(stdout.split(/\r?\n/).map((line) => line.split('\t')).filter((parts) => parts.length >= 2))
  } catch { return {} }
}

async function withWindowsPayload(fullPath, type, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'windows-package-'))
  try {
    if (type === 'msi') await execFileAsync('msiextract', ['-C', directory, fullPath], { maxBuffer: 32 * 1024 * 1024 })
    else await execFileAsync('7z', ['x', '-y', `-o${directory}`, fullPath], { maxBuffer: 32 * 1024 * 1024 })
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function inspectWindowsBinaries(directory) {
  const binaries = await findFiles(directory, (candidate) => /\.(?:exe|dll)$/i.test(candidate))
  const candidates = await Promise.all(binaries.map(async (candidate) => ({ candidate, size: (await stat(candidate)).size })))
  candidates.sort((a, b) => b.size - a.size)
  for (const { candidate } of candidates.slice(0, 20)) {
    const buffer = await readFile(candidate)
    const architectures = parsePeArchitecture(buffer)
    if (architectures.length) return { architectures, minSdk: parsePeMinimumWindows(buffer), iconSource: candidate }
  }
  return { architectures: [], minSdk: '', iconSource: '' }
}

async function cacheWindowsIcon(item, fullPath, type, payloadIconSource = '') {
  return cachedIconPath(item, async (outputPath) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'windows-icon-'))
    try {
      let iconSource = payloadIconSource
      if (!iconSource) {
        await execFileAsync('wrestool', ['-x', '-t', '14', '-o', directory, fullPath])
        iconSource = await findFile(directory, (candidate) => /\.ico$/i.test(candidate))
      }
      if (!iconSource && type === 'msi') throw new Error('no application binary with embedded icon')
      if (!iconSource) throw new Error('no embedded icon')
      if (/\.ico$/i.test(iconSource)) await execFileAsync('convert', [`${iconSource}[0]`, outputPath])
      else {
        const resourceDirectory = path.join(directory, 'resource')
        await mkdir(resourceDirectory)
        await execFileAsync('wrestool', ['-x', '-t', '14', '-o', resourceDirectory, iconSource])
        const iconFile = await findFile(resourceDirectory, (candidate) => /\.ico$/i.test(candidate))
        if (!iconFile) throw new Error('no embedded icon')
        await execFileAsync('convert', [`${iconFile}[0]`, outputPath])
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

async function parseWindowsPackage(fileName, type) {
  const fullPath = path.join(packageDirectory, fileName)
  const fileStat = await stat(fullPath)
  const outerBuffer = type === 'exe' ? await readFile(fullPath) : Buffer.alloc(0)
  const versionInfo = type === 'exe' ? await readWindowsVersionInfo(fullPath) : await readMsiProperties(fullPath)
  let binaryInfo = {
    architectures: type === 'exe' ? parsePeArchitecture(outerBuffer) : [],
    minSdk: type === 'exe' ? parsePeMinimumWindows(outerBuffer) : '',
    iconSource: '',
  }
  let cachedIcon = ''
  try {
    await withWindowsPayload(fullPath, type, async (directory) => {
      const payloadInfo = await inspectWindowsBinaries(directory)
      if (payloadInfo.architectures.length) binaryInfo = payloadInfo
      const iconItem = { fileName, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString(), iconPath: 'embedded' }
      cachedIcon = await cacheWindowsIcon(iconItem, fullPath, type, payloadInfo.iconSource)
    })
  } catch (error) {
    console.warn(`Unable to inspect ${fileName} payload: ${error.message}`)
  }
  if (!cachedIcon && type === 'exe') {
    const iconItem = { fileName, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString(), iconPath: 'embedded' }
    cachedIcon = await cacheWindowsIcon(iconItem, fullPath, type)
  }
  const productName = versionInfo.ProductName || ''
  const fileDescription = versionInfo.FileDescription || ''
  const name = /operating system/i.test(productName) && fileDescription
    ? fileDescription : productName || fileDescription || path.basename(fileName, path.extname(fileName))
  const version = versionInfo.ProductVersion || versionInfo.FileVersion || ''
  const item = {
    id: packageId(fileName), name, packageName: '',
    versionCode: '', versionName: version, minSdk: binaryInfo.minSdk, targetSdk: '', fileName, fullPath,
    size: fileStat.size, modifiedAt: fileStat.mtime.toISOString(), iconPath: 'embedded',
    platform: 'windows', platformLabel: 'Windows',
    ...architectureDetails(binaryInfo.architectures, 'windows'),
  }
  item.cachedIconPath = cachedIcon
  item.hasIcon = Boolean(item.cachedIconPath)
  return item
}

function parsePackage(fileName) {
  const extension = path.extname(fileName).toLowerCase()
  if (extension === '.apk') return parseApk(fileName)
  if (extension === '.ipa') return parseIpa(fileName)
  if (extension === '.dmg') return parseDmg(fileName)
  return parseWindowsPackage(fileName, extension.slice(1))
}

async function fallbackPackage(fileName, error) {
  const fullPath = path.join(packageDirectory, fileName)
  const fileStat = await stat(fullPath)
  const extension = path.extname(fileName).toLowerCase()
  const platform = ({ '.apk': 'android', '.ipa': 'ios', '.dmg': 'macos', '.exe': 'windows', '.msi': 'windows' })[extension]
  const platformLabel = ({ android: 'Android', ios: 'iOS', macos: 'macOS', windows: 'Windows' })[platform]
  console.warn(`Unable to fully parse ${fileName}: ${error.message}`)
  return {
    id: packageId(fileName), name: path.basename(fileName, extension), packageName: '',
    versionCode: '', versionName: '', minSdk: '', targetSdk: '', architectures: [], architectureLabel: '架构未知',
    fileName, fullPath, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString(),
    iconPath: '', cachedIconPath: '', hasIcon: false, platform, platformLabel, parseWarning: '安装包信息未能完整解析',
  }
}

async function scan() {
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  const packageFiles = entries
    .filter((entry) => entry.isFile() && /\.(?:apk|ipa|dmg|exe|msi)$/i.test(entry.name))
    .map((entry) => entry.name)
  const parsed = await Promise.all(packageFiles.map(async (fileName) => {
    try { return await parsePackage(fileName) }
    catch (error) { return fallbackPackage(fileName, error) }
  }))
  cache = new Map(parsed.map((item) => [item.id, item]))
  return parsed.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

app.get('/api/health', (_request, response) => response.json({ status: 'ok', packageDirectory, iconCacheDirectory }))
app.get('/api/apps', async (_request, response) => {
  try {
    const apps = await scan()
    response.json({ apps: apps.map(({ fullPath, iconPath, cachedIconPath, ...item }) => item) })
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
    if (!item?.cachedIconPath) return response.sendStatus(404)
    response.type('image/png')
    response.set('Cache-Control', 'public, max-age=31536000, immutable')
    response.send(await readFile(item.cachedIconPath))
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
app.listen(port, '0.0.0.0', () => console.log(`TV App Store listening on http://0.0.0.0:${port}; PACKAGE_DIR=${packageDirectory}`))
