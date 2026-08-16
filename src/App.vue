<script setup>
import { computed, onMounted, ref } from 'vue'

const apps = ref([])
const loading = ref(true)
const error = ref('')
const query = ref('')

const filteredApps = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return apps.value
  return apps.value.filter((app) =>
    [app.name, app.packageName, app.fileName, app.platformLabel, app.architectureLabel].some((field) => field?.toLowerCase().includes(value)),
  )
})

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

async function loadApps() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/api/apps')
    if (!response.ok) throw new Error(`服务返回 ${response.status}`)
    const data = await response.json()
    apps.value = data.apps
  } catch (reason) {
    error.value = `无法读取应用目录：${reason.message}`
  } finally {
    loading.value = false
  }
}

onMounted(loadApps)
</script>

<template>
  <main>
    <header class="hero">
      <div>
        <p class="eyebrow">LOCAL APK LIBRARY</p>
        <h1>电视应用仓库</h1>
        <p class="subtitle">浏览挂载目录中的 Android 与 Apple 安装包</p>
      </div>
      <button class="refresh" :disabled="loading" @click="loadApps">
        <span :class="{ spin: loading }">↻</span> 刷新目录
      </button>
    </header>

    <section class="toolbar">
      <label class="search">
        <span>⌕</span>
        <input v-model="query" placeholder="搜索应用名称、包名、平台或文件名" />
      </label>
      <div class="count"><strong>{{ filteredApps.length }}</strong> 个应用</div>
    </section>

    <div v-if="error" class="notice error">{{ error }}</div>
    <div v-else-if="loading" class="notice">正在解析 APK 信息…</div>
    <div v-else-if="!filteredApps.length" class="empty">
      <div class="empty-icon">APK</div>
      <h2>{{ query ? '没有匹配的应用' : '目录中还没有 APK' }}</h2>
      <p>{{ query ? '试试其他关键词' : '将 APK、IPA 或 DMG 文件放入挂载目录后点击刷新' }}</p>
    </div>

    <section v-else class="grid">
      <article v-for="app in filteredApps" :key="app.id" class="card">
        <img v-if="app.hasIcon" class="app-icon" :src="`/api/apps/${app.id}/icon`" alt="" />
        <div v-else class="app-icon fallback">{{ app.name?.slice(0, 1)?.toUpperCase() || 'A' }}</div>
        <div class="card-main">
          <h2 :title="app.name">{{ app.name }}</h2>
          <p class="package" :title="app.packageName">{{ app.packageName }}</p>
          <div class="tags">
            <span class="platform" :class="app.platform">{{ app.platformLabel }}</span>
            <span>v{{ app.versionName || app.versionCode || '-' }}</span>
            <span>{{ formatSize(app.size) }}</span>
            <span v-if="app.architectureLabel" class="architecture">{{ app.architectureLabel }}</span>
            <span v-if="app.minSdk">{{ app.platform === 'android' ? 'Android' : 'iOS' }} {{ app.minSdk }}+</span>
          </div>
        </div>
        <footer>
          <div class="file-meta">
            <span :title="app.fileName">{{ app.fileName }}</span>
            <time>{{ app.modifiedAt ? new Date(app.modifiedAt).toLocaleDateString('zh-CN') : '' }}</time>
          </div>
          <a class="download" :href="`/api/apps/${app.id}/download`" :download="app.fileName">
            <span>↓</span> 下载 {{ app.fileName.split('.').pop().toUpperCase() }}
          </a>
        </footer>
      </article>
    </section>
  </main>
</template>
