# TV App Store

扫描指定目录中的 APK、IPA 和 DMG 文件，通过 Vue 页面展示平台、应用信息并提供下载。APK 使用 `aapt` 解析，IPA 从 `Info.plist` 读取元数据，并自动将苹果 CgBI 图标转换为浏览器可显示的 PNG；DMG 作为 macOS 安装镜像展示基础文件信息。

## Docker Compose 运行

```bash
mkdir -p apks
# 将 APK 文件放入 ./apks
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
- APK 目录：宿主机 `./apks` → 容器 `/apks`（只读）

修改宿主机端口或 APK 目录：

```yaml
ports:
  - "8080:3000"
volumes:
  - "/mnt/storage/apks:/apks:ro"
```

也可直接运行：

```bash
docker build -t tv-app-store .
docker run -d --name tv-app-store -p 3000:3000 -v /你的/APK目录:/apks:ro tv-app-store
```

健康检查接口：`GET /api/health`。
