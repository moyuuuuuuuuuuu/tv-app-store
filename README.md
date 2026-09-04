# TV App Store

扫描指定目录中的 APK、IPA、DMG 和 EXE 文件，通过 Vue 页面展示平台、应用信息、处理器架构、应用图标并提供下载。Android/iOS 标记 32/64 位，Windows 标记 x86/x64/ARM，macOS 标记 Intel、M 系列或两者兼容。解包或转换得到的图标会持久化到独立缓存目录，页面请求图标时不再重复解包安装文件。

## Docker Compose 运行

```bash
mkdir -p packages data
# 将 APK、IPA、DMG 或 EXE 文件放入 ./packages
docker compose up -d --build
```

如果曾经构建失败并留下损坏缓存，可使用无缓存方式重新构建：

```bash
docker compose build --no-cache
docker compose up -d
```

打开 <http://localhost:3000>。

默认映射关系：

- Web 端口：宿主机 `3000` → 容器 `3000`
- 安装包目录：宿主机 `./packages` → 容器 `/packages`（只读）
- 图标缓存：宿主机 `./data` → 容器 `/app/data`（可写）

修改宿主机端口或 APK 目录：

```yaml
ports:
  - "8080:3000"
volumes:
  - "/mnt/storage/packages:/packages:ro"
  - "/mnt/storage/tv-app-store-data:/app/data"
```

也可直接运行：

```bash
docker build -t tv-app-store .
docker run -d --name tv-app-store -p 3000:3000 -v /你的安装包目录:/packages:ro -v /你的缓存目录:/app/data tv-app-store
```

健康检查接口：`GET /api/health`。
