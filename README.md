# TV App Store

扫描指定目录中的 APK，使用 `aapt` 解析应用名称、包名、版本、SDK、大小和图标，并通过 Vue 页面展示和下载。

## Docker Compose 运行

```bash
mkdir -p apks
# 将 APK 文件放入 ./apks
docker compose up -d --build
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
