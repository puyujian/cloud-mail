<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">基于 Cloudflare 的简约响应式邮箱服务，支持邮件发送、附件收发 🎉</p> 
    <p align="center">
        简体中文 | <a href="/README-en.md" style="margin-left: 5px">English </a>
    </p>
    <p align="center">
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>    
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail" alt="releases" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/issues" >
            <img src="https://img.shields.io/github/issues/maillab/cloud-mail" alt="issues" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/stargazers" target="_blank">
            <img src="https://img.shields.io/github/stars/maillab/cloud-mail" alt="stargazers" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/forks" target="_blank" >
            <img src="https://img.shields.io/github/forks/maillab/cloud-mail" alt="forks" />
        </a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
    </p>
</p>


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台，本项目支持署到 Cloudflare Workers ，降低服务器成本，搭建自己的邮箱服务

## 项目展示

- [在线演示](https://skymail.ink)<br>
- [部署文档](https://doc.skymail.ink)<br>

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|-----------------------|-----------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |




## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：集成Resend发送邮件，支持群发，内嵌图片和附件发送，发送状态查看

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔢 验证码识别**：使用Workers AI，自动识别邮件验证码 

- **📋 剪贴板同步**：可将识别的验证码同步到自建 SyncClipboardCfServer 实例（默认关闭，只写当前剪贴板）

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **📜 更多功能**：正在开发中...



## SyncClipboard 验证码同步（可选，默认关闭）

把 Workers AI 识别出的邮件验证码，通过 SyncClipboard 协议写入**管理员自己配置的** SyncClipboardCfServer 实例当前剪贴板。
服务端会自行同步 current profile、历史与广播，本功能只负责 `PUT /SyncClipboard.json`，不做二维码。

### 功能行为

- 复用现有验证码提取：只有 `aiCode` 开启且 `aiCodeFilter` 命中、且提取到非空验证码时才同步
- 触发范围 = **已被系统接收的邮件**（黑名单、`receive` 关闭、`noRecipient.CLOSE` 拒收、域名/发件人权限不通过的邮件都不会触发）
- 同步范围由管理员二选一：`全站`（所有被接收的邮件，含未注册收件箱）或 `指定收件邮箱`（逗号分隔名单，大小写不敏感）
- 与 TG / Webhook / 邮件转发、`ruleType` 规则转发**完全独立**：这些渠道异常不影响本功能，本功能异常也不影响收信（`ctx.waitUntil` + 兜底 catch）
- 只发送纯验证码文本，保留前导零；`size` 为字符数
- 请求形状（协议契约）：

```json
{
  "type": "Text",
  "hash": "大写 SHA256(UTF-8 验证码)",
  "text": "012345",
  "hasData": false,
  "dataName": null,
  "size": 6
}
```

### 配置方式

系统设置 → 邮件推送 → SyncClipboard 同步：

| 字段 | 说明 |
| --- | --- |
| 开关 | 默认**关闭** |
| 实例地址 | 必须是 `https://` 裸域名（可带端口），不能带路径/查询/凭据 |
| 用户名 / 密码 | HTTP Basic 凭据；**密码只写不读**，接口永不回显，留空=保留旧值，勾选清除=清空（需先关闭开关） |
| 同步范围 | 全站 / 指定收件邮箱 |
| 收件邮箱 | 指定模式的名单，逗号分隔 |
| 重试次数 | 0–3（默认 2），仅对网络错误 / 5xx / 429 / 408 生效 |
| 测试连接 | **只读** `GET /api/version`（无则回退 `GET /SyncClipboard.json`），绝不覆盖剪贴板 |

接口 `GET /api/setting/querySyncClipboard`、`PUT /api/setting/setSyncClipboard`、`PUT /api/setting/testSyncClipboard`
均要求 `setting:query` / `setting:set` 权限：

- **授权管理接口会返回实例 URL、用户名与 `hasPassword` 布尔值，但永不返回密码**（密码写入后无法回读，只能重新设置或清除）
- `/setting/query`（通用设置读取）只回传 `hasSyncClipboardPassword`，不返回本功能的 URL/用户名/密码
- `/setting/websiteConfig`（公开接口）**不包含本功能任何字段**（无开关/URL/用户名/密码/名单）

### 数据库升级（推荐窄口径迁移）

本功能只需要给 `setting` 表补 8 个新列（都有默认值，功能默认关闭）。

**推荐路径：先补列，再部署，再首次保存刷新 KV**

1. 补列（幂等，可重复执行；列定义唯一来源 `mail-worker/src/init/setting-columns.mjs`，与 Worker 内 `v3_4DB` 共用）：

```bash
cd mail-worker
# 默认：本地库 + dry-run（只打印计划，零写入）
node scripts/migrate-sync-clipboard.mjs

# 远端正式库：必须同时给 --remote + --allow-remote-write + ALLOW_REMOTE_WRITE=1
ALLOW_REMOTE_WRITE=1 node scripts/migrate-sync-clipboard.mjs \
  --remote --allow-remote-write --apply --config wrangler.toml --database <D1名称>
```

   工具只做「读 `PRAGMA table_info(setting)` → 逐列 ALTER → 复核」，不硬编码账号/凭据（认证交给 wrangler 登录态或部署工程师的授权桥）；
   也等同于手工执行下面 8 条 SQL（缺哪条补哪条）：

```sql
ALTER TABLE setting ADD COLUMN sync_clipboard_status INTEGER NOT NULL DEFAULT 1;
ALTER TABLE setting ADD COLUMN sync_clipboard_url TEXT NOT NULL DEFAULT '';
ALTER TABLE setting ADD COLUMN sync_clipboard_username TEXT NOT NULL DEFAULT '';
ALTER TABLE setting ADD COLUMN sync_clipboard_password TEXT NOT NULL DEFAULT '';
ALTER TABLE setting ADD COLUMN sync_clipboard_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE setting ADD COLUMN sync_clipboard_emails TEXT NOT NULL DEFAULT '';
ALTER TABLE setting ADD COLUMN sync_clipboard_retry INTEGER NOT NULL DEFAULT 2;
ALTER TABLE setting ADD COLUMN sync_clipboard_timeout INTEGER NOT NULL DEFAULT 5000;
```

2. 部署新版本 Worker（保持现有绑定与 assets）。
3. 管理员在「系统设置 → 邮件推送 → SyncClipboard」保存一次配置（或访问一次 `/init`）即会把新字段写入 KV；
   **KV 缺字段时运行时会按“关闭”处理**，不会误开。

> `GET /api/init/<jwt_secret>` 会执行**全部历史迁移**（历史 `UPDATE`、索引重建等），对本功能并非必需，
> 也不是推荐的首选升级方式；仅在需要一并补齐其他历史变更时使用。

迁移语义：先读 `PRAGMA` 再逐列补缺，旧库 / 全新库 / 半升级（上次中途失败）/ 重复执行都能恢复到完整状态；
只有“并发下另一个迁移刚补上同列”才容错，其他真实写库错误会直接上抛（工具退出非 0，`/init` 返回失败）。

### 安全设计

- 只允许 HTTPS，且必须是公网域名：拒绝 URL 内嵌凭据、IP 字面量（含 `[::1]`/十进制 IP）、`localhost`/`*.local`/`*.internal`、非根路径
- 请求固定 `redirect: 'manual'`，**绝不跟随跳转**，避免 Basic 凭据被带到第三方主机
- 超时用 `AbortController`（1–15s，默认 5s）；401/403 与其他 4xx 不重试；5xx/429/408/网络错误有限重试（最多 3 次，退避 250/500/750ms）
- 单次同步（含全部重试与退避）受 25s 总预算硬约束，确保落在 `ctx.waitUntil` 后台窗口内
- 不读取、不缓存目标响应体；日志只输出固定原因与 `emailId`/状态码，**不含验证码、密码、目标地址、响应体或异常 message**
- 设置读取返回脱敏副本，掩码不会写回缓存对象，不会破坏原凭据导致发信失败

### 去重与顺序（已知限制，best effort）

- 去重键 = `messageId`（缺失时用 `emailId`）+ 收件邮箱，键与 KV 值都不含验证码；同码不同邮件允许各写一次
- 仅在写入成功后打去重标记，失败可重试；标记 TTL 24 小时
- **不承诺全局原子 exactly-once**：KV 最终一致且无跨请求原子性，重复投递极少数情况下可能双写
- **不保证顺序**：没有持久有序队列，乱序/延迟到达的邮件仍按到达顺序写入，**晚到的旧验证码可能覆盖新值**；
  需要严格顺序保证时应在服务端侧处理
- 目标域名解析到内网 IP 的情况无法在配置期判定（只按字面量校验），部署时应保证 DNS 可信

### 本地测试

```bash
cd mail-worker
pnpm install --frozen-lockfile
pnpm test        # 本地单测（vitest + miniflare 本地 D1/KV，不写远端）
pnpm run test:watch

# 窄屏弹窗布局守卫（无头 Chromium + 构建产物 CSS，需先 build）
pnpm run test:layout
```

> 注意：`pnpm test` 现在是本地单测；原先“部署到测试环境”的脚本改名为 `pnpm run deploy:test`（`wrangler deploy -c wrangler-test.toml`）。
> 测试使用 `wrangler-test-local.toml` 中的**本地模拟** D1/KV，禁止把 `--remote` 加进单测。

`pnpm run test:layout` 用无头 Chromium 按真实视口（320×568 / 390×844 / 1280×633）测量构建产物 CSS + 复刻的弹窗 DOM，断言 Save/Test 完整可见可点、无横向溢出、窄屏开关与按钮组换行；
并把「删除新规则后必须复现溢出」作为对照组（证明该测量真的在测这件事）。源码层面的结构/样式契约由 `test/sync-clipboard-dialog-layout.spec.js` 在 `pnpm test` 中守护。

构建物位置：前端 `mail-vue` 以 `--mode release` 构建，输出到 `mail-worker/dist`（由 `wrangler.toml` 的 `assets.directory` 上传），Worker 代码由 `wrangler deploy` 打包。

### 线上验收

`mail-worker/test/online/verify-sync-clipboard.mjs` 分两种模式，严格分离：

- **只读连通性检查（默认）**：只做 `GET /api/version`（看状态码）、只读测试连接（`PUT /api/setting/testSyncClipboard`，后端仅 GET）、读配置摘要（status/mode/hasPassword/retry 与目标主机名）。
  **不读取/不打印任何邮件正文或剪贴板内容，不要求外部发信，不等待验证码**，也不修改任何配置。
- **集成验收（`--apply`）**：写配置 → 等外部真实邮件 → 校验剪贴板（输出只有长度/布尔/状态码，**不打印验证码与剪贴板正文**）。
  站内发信不走 Email Worker，不会触发同步，必须从**站外**发信。

安全约束（脚本内置）：

- 凭据只从环境变量读取（`SYNC_USER` / `SYNC_PASS`），**命令行传密码会被拒绝**（避免留在进程列表）
- `--apply` 必须同时满足：显式 `--expect-host` 且与 `--sync-url` 主机一致、环境变量 `ALLOW_REMOTE_TARGET=1`
- `--apply` 拒绝在「已有密码 `hasPassword=true`」「已开启 `status=0`」「已指向其他目标」的配置上执行，避免覆盖用户正式目标与凭据；建议只对隔离实例使用
- `--restore` 在结束后恢复脚本前的配置（起始状态必为“关闭且无密码”，因此会一并清除本次测试密码）

```bash
cd mail-worker
# 只读检查
WORKER_URL=https://mail.example.com ADMIN_JWT=... \
SYNC_URL=https://sync-test.example.workers.dev SYNC_USER=admin SYNC_PASS=... \
node test/online/verify-sync-clipboard.mjs

# 集成验收（隔离实例）
ALLOW_REMOTE_TARGET=1 WORKER_URL=... ADMIN_JWT=... SYNC_URL=... SYNC_USER=... SYNC_PASS=... \
node test/online/verify-sync-clipboard.mjs --apply --expect-host sync-test.example.workers.dev \
  --recipient admin@example.com --restore
```

## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件推送：** [Resend](https://resend.com/)

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## 目录结构

```
cloud-mail
├── mail-worker				    # worker后端项目
│   ├── src                  
│   │   ├── api	 			    # api接口层			
│   │   ├── const  			    # 项目常量
│   │   ├── dao                 # 数据访问层
│   │   ├── email			    # 邮件处理接收
│   │   ├── entity			    # 数据库实体
│   │   ├── error			    # 自定义异常
│   │   ├── hono			    # web框架配置、拦截器、全局异常等
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 数据库缓存初始化
│   │   ├── model			    # 响应体数据封装
│   │   ├── security			# 身份权限认证
│   │   ├── service			    # 业务服务层
│   │   ├── template			# 消息模板
│   │   ├── utils			    # 工具类
│   │   └── index.js			# 入口文件
│   ├── pageckge.json			# 项目依赖
│   └── wrangler.toml			# 项目配置
│
├── mail-vue				    # vue前端项目
│   ├── src
│   │   ├── axios 			    # axios配置
│   │   ├── components			# 自定义组件
│   │   ├── echarts			    # echarts组件导入
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 入站初始化
│   │   ├── layout			    # 主体布局组件
│   │   ├── perm			    # 权限认证
│   │   ├── request			    # api接口
│   │   ├── router			    # 路由配置
│   │   ├── store			    # 全局状态管理
│   │   ├── utils			    # 工具类
│   │   ├── views			    # 页面组件
│   │   ├── app.vue			    # 入口组件
│   │   ├── main.js			    # 入口js
│   │   └── style.css			# 全局css
│   ├── package.json			# 项目依赖
└── └── env.release				# 项目配置
```

## 赞助

<a href="https://doc.skymail.ink/support.html" >
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



