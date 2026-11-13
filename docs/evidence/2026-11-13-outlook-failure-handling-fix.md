# Mail Hub Outlook 故障处理修复

日期：2026-11-13（日本时间）。本次仅本地代码与验证，不部署，不调整生产代理，不注册、重发或操作首次注册检查点。

## 归因边界

输入依据：[代码缺陷及复现](2026-11-13-outlook-graph-diagnosis.md)、[微软事件关联修正](2026-11-13-outlook-microsoft-incident.md)。这次修复应用的取消、预算、诊断和资源生命周期问题，不是微软服务故障或代理节点故障的根因修复，也不承诺消除全部 502。

## 同类排查与处理

| 类别 | 排查范围及修复 | 契约回归 |
| --- | --- | --- |
| 取消被覆盖 | 1 个共享 helper 的直连、代理共 2 个分支，均合并调用方信号、路由截止、单次超时 | `http-retry`：预取消、响应头等待、退避、正文、未消费响应，直连/代理参数化覆盖 |
| 总预算缺失 | latest、matching、管理历史 3 条流程；同时覆盖租户列表/详情、管理员详情。预算通过 AsyncLocalStorage 传给 OAuth、文件夹、详情和共享 HTTP helper | `outlook-scan`：latest/matching 的 OAuth 和正文均受 1 秒路由预算约束；`outlook-history`：取消与失败分页重试 |
| 兄弟读取未取消 | 双文件夹聚合原 3 处 Promise.all 改为 1 个共享聚合器；失败后取消并等待本次兄弟任务结束，仍抛出原始失败 | `outlook-messages`：Graph/REST 一侧 503 使另一侧 signal 取消，列表拒绝，不伪装空邮箱 |
| 代理实例未退役 | 1 个缓存实现；替换时标记退役，引用计数归零才调用 graceful close，不 destroy；并发失败不重复替换已经换新的缓存 | `http-retry`：重试时旧实例尚有正文读取，须保持可用；正文完成后只关闭一次 |
| 诊断丢失 | 1 个 logger cause 实现、租户共享失败出口和管理员历史/详情出口；Microsoft HTTP 的 7 个调用点标注受控操作 | `logger`、`http-transport`：cause 环、原生 DOMException、CONNECT 502/504、TLS 等待、响应头、正文、脱敏 |
| 列表负载 | 1 个普通列表函数改用元数据字段，Graph/REST 共用；详情继续请求 body | `outlook-messages`：两套 API 的列表无 body，详情有 body，To/Cc 保留；原有租户范围测试继续执行 |

新顶层 socket 测试的契约是：实际 Node fetch/undici 收到取消后停止传输，并产出可归因、不含秘密的日志。这一契约不能仅由 fetch mock 证明。

## 行为保持与预算

- 默认 GET/HEAD 仍最多 3 次尝试、800/1600ms 退避，单次默认 15 秒；POST 默认不重放，未新增 HTTP 429/5xx 自动重试策略。
- `/code` 使用既有 `timeout`（默认 60 秒、上限 120 秒）作为整条读取截止；管理历史/详情 30 秒，租户列表/详情 60 秒。单次尝试不能超过剩余预算；取消或总预算到期立即停止退避及后续尝试。
- 正文仍由调用点消费；返回原始 Response，保留既有 OAuth 文本检查点与凭据轮换顺序。正文消费失败不自动重放请求。
- 保留 latest 的排序、选择与普通详情失败摘要回退；总预算耗尽的详情不回退为成功。matching 继续按原协议返回显式不完整的 timeout 元信息。文件夹读取失败保持 502/429。
- 保留别名 To/Cc、租约窗口、分页令牌、额度和令牌检查三态语义。网络错误仍不是 invalid 凭据证据。

## 诊断字段与限制

`upstream attempt` 记录 requestId、内部 operationId、operation（oauth/inbox/junk/detail/token_check）、attempt、durationMs、phaseDurationMs、transport、phase，以及可获得的 connectStatus、HTTP status、微软 upstreamRequestId 和受限 error/cause/code。

cause 最多 6 层，循环和 AggregateError 子项均有界；只读取数据描述符，不调用上游 getter/toJSON。原生 AbortError/TimeoutError 使用平台品牌校验的名称访问器。只保留白名单 code 和合法 GUID 请求 ID；不输出原始错误 message/stack、完整 URL、查询、Authorization、代理鉴权、邮箱正文或确认链接。

undici 事件绑定请求对象/异步尝试上下文，已结束尝试的迟到事件不会覆盖下一次尝试。复用连接可能没有新的 CONNECT 事件，此时状态省略；`connect` 表示尚未取得更具体的连接阶段证据。已观测到 CONNECT 200 后的等待可以标为 TLS，已发送请求后为 response_headers，正文消费为 body。不能据缺失事件推断代理或微软根因。

## 验证记录

- 本地 Node v24.11.1。原生产诊断运行时为 v24.22.2，本次未部署、未重跑生产邮箱。
- 第一轮共享 helper/logger 红灯：15 失败 / 48 通过，覆盖取消、预算与 cause 丢失（`.tmp/fault-red.log`）。
- DOMException 诊断补充红灯：2 失败 / 9 通过（`.tmp/fault-logger-red-2.log`）。
- 实际 socket 首轮发现正文 requestId 丢失、TLS 被记成 proxy_connect：2 失败 / 14 通过；修正后通过。
- 相关测试：9 文件 / 292 项通过（`.tmp/fault-targeted-final.log`）。
- 本地实际 socket：5 项通过，验证响应头/正文截止时服务端连接关闭，以及 CONNECT 502/504、CONNECT 成功后的 TLS 等待。仅使用 loopback 服务和虚构凭据，无生产数据（`.tmp/fault-sockets.log`）。
- 构建：最终 `npm run build` 通过（`.tmp/fault-build-final.log`）；`git diff --check` 通过。
- 首次全量：1943 通过 / 2 失败。补回轮询睡眠取消后的所有权/删除检查；修正测试的睡眠就绪判断（截止 timer 不代表首次列表已完成）。iCloud 旧 fixture 在恰好 15 秒时成功且不响应取消，改为同时测试 14999ms 内成功、15000ms 到期拒绝且不继续写入。120 秒租约的断言仍保留。这两文件相关 97 项通过（`.tmp/fault-full-repair-2.log`）。
- 最终全量：**68 文件 / 1946 项全部通过**，2026-11-13 16:08:10 JST 开始，耗时 132.06 秒（`.tmp/fault-full-final.log`）。稳定摘要见 [验证输出](2026-11-13-outlook-failure-handling-validation.txt)。

未验证：生产网络恢复、微软故障恢复、实际邮件验证码/确认链接业务恢复、生产并发长时间压力。原诊断文件、首次注册凭据与检查点均保留；没有进行补救式删除。
