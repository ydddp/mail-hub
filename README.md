# Mail Hub

[![GHCR](https://img.shields.io/badge/ghcr-ydddp%2Fmail--hub-blue)](https://github.com/ydddp/mail-hub/pkgs/container/mail-hub)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

多渠道临时邮箱聚合服务 — 统一 API 对接 10+ 邮件提供商，自动轮询收件、提取验证码。

[English](README_EN.md) | [API 文档](docs/API.md)

## 功能特性

- **10+ 渠道聚合** — 统一 REST API，无需对接各家 SDK
- **可见的调度顺序** — 不指定渠道时按你设定的顺序逐个尝试（可全局、可按目标服务），跳过禁用/限流/冷却中的，`/api/dispatch/preview` 可预演
- **自定义渠道** — Web UI 添加 REST / GraphQL 邮件渠道，无需写代码
- **验证码提取** — 自动识别数字、字母数字、链接型验证码；Outlook 支持匹配取码和按邮件 ID 继续获取
- **Outlook 收件与历史** — 接收时间精确到秒，分开展示收件别名与到达时段；有界扫描 Inbox/Junk，管理员可加载更早邮件
- **失败恢复与隔离** — 收件人及租期隔离；模板建号后认证失败保留恢复记录，避免重复创建和遗失凭据
- **账号池管理** — Outlook / YYDS Mail / IMAP 域名邮箱 / iCloud 别名批量管理
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

需要 Node.js 22+（推荐 24 LTS）：

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

以下渠道为代码内置（非模板），通过 **渠道管理** 页面配置启用、是否参与自动调度和调度顺序，并有独立管理界面（侧边栏入口）：

| 渠道 | 类型 | 说明 |
|------|------|------|
| Outlook | 账号池 | 导入 Outlook 账号，自动识别 Microsoft Graph、Outlook REST 与 IMAP XOAUTH2（含 Thunderbird 公共 OAuth 令牌）；支持裸账号授权补全；1:1 分配，关闭后回池；可选 `+` 子地址别名；账号页可分开展示收件地址和到达时段，并加载更早邮件 |
| YYDS Mail | API Key 池 | 导入 Key，按 key 轮转，单 Key 每日 20,000 次调用 |
| IMAP 域名邮箱 | 账号池 | 连接自有域名邮箱（catch-all），一个邮箱支撑多个收件箱；生成人名形态地址，默认调度顺序排最前 |
| iCloud 别名 | 地址池 | 用 iCloud+ 的隐藏邮件地址签发 `@icloud.com` 地址，转发到你自己的信箱后按收件人分拣；地址回收复用，后台按 Apple 的限速自动补货 |

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
curl -X POST http://localhost:3100/api/inbox \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"for": "twitter.com"}'

# 创建收件箱（要一个别名地址，如 account+ab12cd@outlook.com）
# 标签由服务端生成；仅 Outlook 支持，其他渠道忽略此项
curl -X POST http://localhost:3100/api/inbox \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"for": "twitter.com", "alias": true}'

# 多个 Apple ID 时指定用哪个签发地址（仅 iCloud 渠道）
# 不传则从所有可用账号里挑用得最少的那个地址
curl -X POST http://localhost:3100/api/inbox \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"for": "twitter.com", "provider": "icloud", "account": "me@icloud.com"}'

# 获取邮件
curl http://localhost:3100/api/inbox/{id}/messages \
  -H "Authorization: Bearer YOUR_KEY"

# 提取验证码（支持长轮询）
curl "http://localhost:3100/api/inbox/{id}/code?wait=true" \
  -H "Authorization: Bearer YOUR_KEY"

# Outlook 多次取件：重复传入已返回的 messageId，同秒其他邮件仍可匹配
curl "http://localhost:3100/api/inbox/{id}/code?selection=matching&wait=true&excludeMessageId=message-123" \
  -H "Authorization: Bearer YOUR_KEY"

# 上报结果
curl -X POST http://localhost:3100/api/inbox/{id}/report \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"success": true, "service": "twitter.com"}'

# 关闭收件箱
curl -X DELETE http://localhost:3100/api/inbox/{id} \
  -H "Authorization: Bearer YOUR_KEY"
```

典型流程：`创建 → 提取验证码 → 上报结果 → 关闭`

完整 API 文档：[docs/API.md](docs/API.md)
AI/LLM 集成端点：`GET /v1/llms.txt`（无需认证）

## License

[AGPL-3.0-or-later](LICENSE)
