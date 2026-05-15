# Mail Hub

[![GHCR](https://img.shields.io/badge/ghcr-ydddp%2Fmail--hub-blue)](https://github.com/ydddp/mail-hub/pkgs/container/mail-hub)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

多渠道临时邮箱聚合服务 — 统一 API 对接 10+ 邮件提供商，自动轮询收件、提取验证码。

[English](README_EN.md) | [API 文档](docs/API.md)

## 功能特性

- **10+ 渠道聚合** — 统一 REST API，无需对接各家 SDK
- **智能调度** — 按信任度、限速、封禁域名自动选最优渠道
- **自定义渠道** — Web UI 添加 REST / GraphQL 邮件渠道，无需写代码
- **验证码提取** — 自动识别数字、字母数字、链接型验证码
- **账号池管理** — Outlook / YYDS Mail / IMAP 域名邮箱批量管理
- **权限控制** — API Key 分级（管理员 / 普通用户 + 配额限制）
- **Gmail 别名生成器** — dot-trick / +后缀 / googlemail.com 等价域
- **中文 Web 面板** — 仪表盘、渠道管理、封禁表、系统设置

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/ydddp/mail-hub.git
cd mail-hub
echo "API_SECRET=your-secret" > .env
docker compose up -d
```

浏览器打开 `http://localhost:3100`，用 `.env` 中设置的 `API_SECRET` 登录。

### Docker

```bash
docker run -d \
  --name mail-hub \
  -p 3100:3100 \
  -v ./data:/app/data \
  -e API_SECRET=your-secret \
  --restart unless-stopped \
  ghcr.io/ydddp/mail-hub:latest
```

### Node.js（开发）

需要 Node.js 18+：

```bash
git clone https://github.com/ydddp/mail-hub.git
cd mail-hub
npm install
cp .env.example .env
# 编辑 .env，设置 API_SECRET
npm run dev
```

### PM2（生产）

```bash
npm install
npm run build
pm2 start ecosystem.config.cjs
```

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
|---------|------|--------|------|
| `API_SECRET` | 推荐 | — | 管理员密钥。留空则所有请求均为管理员（仅开发环境） |
| `PORT` | 否 | `3100` | 服务端口 |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `DB_PATH` | 否 | `./data/mail.db` | SQLite 数据库路径 |
| `PROXY_URL` | 否 | — | 出站代理，支持 http/https/socks5 |

详见 [.env.example](.env.example)。

## 内置渠道

### 模板渠道

以下渠道作为内置模板随服务发布，可在管理面板 **自定义渠道** 页面启用、停用、编辑：

| 渠道 | 默认 | 类型 | 保留时长 |
|------|------|------|----------|
| Mail.tm | ✅ | REST | 数天 |
| Mail.gw | ✅ | REST | 8 天 |
| TempMail.lol | ✅ | REST | 1 小时 |
| TempMail.ing | ✅ | REST | 10 分钟 |
| Temp-Mail.io | ✅ | REST | ~24 小时 |
| Maildrop.cc | ✅ | GraphQL | ~24 小时（公开可读） |
| Catchmail.io | ✅ | REST | 7 天 |
| NiMail.cn | ✅ | REST | 10 分钟 |
| Guerrilla Mail | ✅ | REST | 1 小时 |
| Dropmail.me | ❌ | GraphQL | 10 分钟。需在 [dropmail.me/api](https://dropmail.me/api/) 申请 token，编辑模板替换 `PASTE_YOUR_TOKEN_HERE` 后启用 |

> 删除内置模板只删数据库行，重启后自动还原。

### 硬编码渠道

以下渠道为代码内置（非模板），通过 **渠道管理** 页面配置启用/优先级，并有独立管理界面（侧边栏入口）：

| 渠道 | 类型 | 说明 |
|------|------|------|
| Outlook | 账号池 | 导入 Outlook 账号，1:1 分配，关闭后回池 |
| YYDS Mail | API Key 池 | 导入 Key，按 key 轮转，单 Key 每日 20,000 次调用 |
| IMAP 域名邮箱 | 账号池 | 连接自有域名邮箱（catch-all），信任度最高 |

## 自定义渠道

管理面板 **自定义渠道** 页面可通过 JSON 配置添加任意 REST 或 GraphQL 邮件渠道：

1. 点击 **新建渠道**
2. 从下拉选择预设模板：
   - **两步创建 + Bearer** — Mail.tm 风格（先 POST 创建账号，再 POST 换 token）
   - **API Key Header** — 全局认证头（如 `X-Api-Key`）
   - **无认证** — 详情直接复用列表返回的 item
   - **GraphQL POST + body** — Dropmail 风格（同 URL POST + `{query: "..."}`）
3. 填表单或直接编辑右侧 JSON
4. **测试连接** 跑全链路验证：getDomains → createInbox → getMessages → deleteInbox
5. 保存即生效，无需重启

## 内置工具

**Gmail 别名生成器**（侧边栏 **Gmail 别名**）：基于 dot-trick、`+` 后缀、googlemail.com 等价域生成大量别名，全部进入同一收件箱。纯前端运行，无需配置。

## API 概览

所有 `/api/*` 接口需携带 Bearer Token：

```
Authorization: Bearer <your-api-secret-or-api-key>
```

```bash
# 创建收件箱
curl -X POST http://localhost:3100/api/inboxes \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"for": "twitter.com"}'

# 获取邮件
curl http://localhost:3100/api/inboxes/{id}/messages \
  -H "Authorization: Bearer YOUR_KEY"

# 提取验证码（支持长轮询）
curl "http://localhost:3100/api/inboxes/{id}/code?wait=true" \
  -H "Authorization: Bearer YOUR_KEY"

# 上报结果
curl -X POST http://localhost:3100/api/inboxes/{id}/report \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"success": true, "service": "twitter.com"}'

# 关闭收件箱
curl -X DELETE http://localhost:3100/api/inboxes/{id} \
  -H "Authorization: Bearer YOUR_KEY"
```

典型流程：`创建 → 提取验证码 → 上报结果 → 关闭`

完整 API 文档：[docs/API.md](docs/API.md)
AI/LLM 集成端点：`GET /v1/llms.txt`（无需认证）

## License

[AGPL-3.0-or-later](LICENSE)
