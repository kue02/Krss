# Krss

[![License: GPL v2](https://img.shields.io/badge/License-GPL_v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Build Docker Image](https://github.com/hu2327401139/krss/actions/workflows/docker-build.yml/badge.svg)](https://github.com/hu2327401139/krss/actions/workflows/docker-build.yml)

轻量级自托管 RSS 阅读器，界面参照 Nextflux 的风格重做，内置 AI 能力。

## 功能特性

- 全格式订阅：RSS 2.0 / Atom / JSON Feed
- Readability 沉浸式阅读模式（正文提取 + 图集）
- AI 摘要与翻译，支持 OpenAI / Anthropic 及兼容接口（BYOK）
- 自动化过滤规则：按关键词 / 正则 / 来源命中并自动处理条目
- 文件夹分层管理、未读与星标视图
- 浅色 / 深色 / 跟随系统主题
- PWA，可安装到桌面与移动设备
- 多语言（简体中文 / English）

## 部署

### Docker Compose（推荐）

```bash
curl -O https://raw.githubusercontent.com/hu2327401139/krss/main/docker-compose.yml
docker compose up -d
```

或手动创建 `docker-compose.yml`：

```yaml
services:
  krss:
    image: ghcr.io/hu2327401139/krss:latest
    container_name: krss
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
    environment:
      - KRSS_LOG_LEVEL=info
    restart: always
```

访问 `http://localhost:8080`，数据持久化在 `./data` 目录。

### Docker Run

```bash
docker run -d \
  --name krss \
  -p 8080:8080 \
  -v ./data:/app/data \
  ghcr.io/hu2327401139/krss:latest
```

### 环境变量

| 变量                | 默认值        | 说明                                            |
| ------------------- | ------------- | ----------------------------------------------- |
| `KRSS_ADDR`         | `:8080`       | 监听地址                                        |
| `KRSS_DATA_DIR`     | `./data`      | 数据目录（容器内为 `/app/data`）                |
| `KRSS_DB_PATH`      | `data/krss.db`| SQLite 数据库文件路径                           |
| `KRSS_STATIC_DIR`   | 自动探测      | 前端静态文件目录                                |
| `KRSS_LOG_LEVEL`    | `info`        | 日志级别（`debug` / `info` / `warn` / `error`） |
| `KRSS_SWAGGER`      | `false`       | 设为 `true` 在本机开启 `/swagger/index.html`    |
| `KRSS_ENABLE_PPROF` | `false`       | 开启 pprof 性能分析                             |
| `KRSS_PPROF_ADDR`   | `127.0.0.1:6060` | pprof 监听地址                               |

## 本地开发

### 前置依赖

- Go 1.25+
- [Bun](https://bun.sh/)

### 后端

```bash
cd backend
go mod download
go run ./cmd/server       # 默认 http://localhost:8080，数据落在 ./data
```

### 前端

```bash
cd frontend
bun install
bun run dev               # http://localhost:5173，默认代理到 :8080
```

跑在别的端口（并行开发）时用 `KRSS_DEV_BACKEND` 指定后端：

```bash
KRSS_DEV_BACKEND=http://localhost:8082 bun run dev
```

### 测试与质量门

```bash
# 后端
cd backend
make test                 # go test ./... -race
make lint                 # golangci-lint run

# 前端
cd frontend
bun run test              # vitest run
bunx tsc -b               # 类型检查
bun run build             # 产物在 dist/
```

## 目录结构

```
backend/            Go 后端（API、SQLite、抓取与解析）
frontend/           React + Vite 前端
docker/             Dockerfile 与 entrypoint
.github/workflows/  CI：后端/前端测试、镜像构建、发布
docker-compose.yml  一键部署
```

## 致谢

界面与交互参考了这些项目，特此致谢：

- [Gist](https://github.com/9bingyin/Gist) —— 本项目的上游基座（后端与数据模型）
- [Nextflux](https://github.com/electh/nextflux) —— 界面与交互参照
- [Folo](https://github.com/RSSNext/Folo) —— 信息流与条目形态参照

## 许可证

[GPL-2.0](./LICENSE)
