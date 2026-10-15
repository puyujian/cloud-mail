<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">A simple, responsive email service designed to run on Cloudflare Workers 🎉</p> 
    <p align="center">
       <a href="/README.md" style="margin-left: 5px">简体中文</a> | English 
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

## Description
With only one domain, you can create multiple different email addresses, similar to major email platforms. This project can be deployed on Cloudflare Workers to reduce server costs and build your own email service.
## Project Showcase

- [Live Demo](https://skymail.ink)<br>
- [Deployment Guide](https://doc.skymail.ink/en/)<br>


| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|--------------------------|--------------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |

## Features

- **💰 Low-Cost Usage**: No server required — deploy to Cloudflare Workers to reduce costs.

- **💻 Responsive Design**: Automatically adapts to both desktop and most mobile browsers.

- **📧 Email Sending**: Integrated with Resend, supporting bulk email sending and attachments.

- **🛡️ Admin Features**: Admin controls for user and email management with RBAC-based access control.

- **📦 Attachment Support**: Send and receive attachments, stored and downloaded via R2 object storage.

- **🔔 Email Push**: Forward received emails to Telegram bots or other email providers.

- **📡 Open API**: Supports batch user creation via API and multi-condition email queries

- **🔢 Verification Code Recognition**: Auto-detect codes via Workers AI

- **📋 Clipboard Sync**: Push detected codes to your own SyncClipboardCfServer instance (disabled by default, writes the current clipboard only)

- **📈 Data Visualization**: Use ECharts to visualize system data, including user email growth.

- **🎨 Personalization**: Customize website title, login background, and transparency.

- **🤖 CAPTCHA**: Integrated with Turnstile CAPTCHA to prevent automated registration.

- **📜 More Features**: Under development...

## SyncClipboard Code Sync (optional, disabled by default)

Pushes the verification code detected by Workers AI into the current clipboard of the SyncClipboardCfServer instance
**configured by the admin**. The server keeps the current profile, history and broadcasts itself; this integration only
issues `PUT /SyncClipboard.json`. QR codes are not supported.

### Behaviour

- Reuses the existing extraction: only when `aiCode` is enabled, `aiCodeFilter` matches and a non-empty code was extracted
- Trigger scope = **emails actually accepted by the system** (blacklisted, `receive` disabled, `noRecipient.CLOSE` rejects and
  domain/sender permission failures never trigger)
- Scope is admin-selectable: `all` (every accepted email, including unregistered mailboxes) or `selected recipients`
  (comma separated, case-insensitive)
- Fully independent of Telegram / Webhook / email forwarding and of the legacy `ruleType` rules: their failures never block
  this integration, and this integration never breaks mail delivery (`ctx.waitUntil` + catch)
- Sends the plain code, preserving leading zeros; `size` is the character count
- Request shape (protocol contract):

```json
{
  "type": "Text",
  "hash": "UPPERCASE SHA256(UTF-8 code)",
  "text": "012345",
  "hasData": false,
  "dataName": null,
  "size": 6
}
```

### Configuration

System settings → Email push → SyncClipboard Sync:

| Field | Notes |
| --- | --- |
| Switch | **Disabled** by default |
| Instance URL | Must be a bare `https://` host (port allowed); no path, query or embedded credentials |
| Username / Password | HTTP Basic credentials; the **password is write-only** and is never returned by any API. Leave empty to keep the current value, tick clear to erase it (disable sync first) |
| Scope | All mailboxes / selected recipients |
| Recipients | Comma separated list for selected mode |
| Retries | 0–3 (default 2); applied to network errors / 5xx / 429 / 408 only |
| Test connection | **Read-only** `GET /api/version` (falls back to `GET /SyncClipboard.json`); never overwrites the clipboard |

APIs: `GET /api/setting/querySyncClipboard`, `PUT /api/setting/setSyncClipboard`, `PUT /api/setting/testSyncClipboard`,
all requiring `setting:query` / `setting:set`. `/setting/query` only returns `hasSyncClipboardPassword`, and the public
`/setting/websiteConfig` never contains any of these fields.

### Database upgrade

After deploying, call `GET /api/init/<jwt_secret>` once (same upgrade path as before; the GitHub Actions workflow already does this):

- New migration `v3_4DB` adds the 8 `sync_clipboard_*` columns to `setting` and refreshes the KV cache at the end
- It reads `PRAGMA table_info(setting)` first and adds **missing columns one by one**: old, fresh, partially migrated and
  repeated runs all converge; only a concurrent `/init` adding the same column is tolerated, every other database error is thrown
- All new columns have defaults and the feature is **disabled by default**; if KV lacks the new fields the runtime treats the feature as off

### Security

- HTTPS only, public hostnames only: rejects embedded credentials, IP literals (`[::1]`, decimal IPs), `localhost`/`*.local`/
  `*.internal` and non-root paths
- Always `redirect: 'manual'` — redirects are **never followed**, so Basic credentials cannot leak to a third-party host
- `AbortController` timeouts (1–15s, default 5s); 401/403 and other 4xx are never retried; 5xx/429/408/network errors are retried
  at most 3 times with a 250/500/750ms backoff
- The whole operation (retries included) is capped by a 25s budget so it always fits the `ctx.waitUntil` window
- Response bodies are never read or cached; logs contain a fixed reason plus `emailId`/status only — **never the code, password,
  target URL, response body or exception message**
- Settings reads return a masked copy and never write masks back into the cached object, so stored credentials cannot be corrupted

### Deduplication and ordering (best effort, known limits)

- Dedup key = `messageId` (or `emailId` when absent) + recipient; neither the key nor the KV value contains the code, so the
  same code in different emails is written twice
- The marker is written only after a successful PUT (failures stay retryable); marker TTL is 24 hours
- **No global exactly-once guarantee**: KV is eventually consistent and there is no cross-request atomicity, so a duplicate
  delivery can rarely write twice
- **No ordering guarantee**: there is no persistent ordered queue, so out-of-order or delayed emails are written in arrival
  order and **an older, late code can overwrite a newer value**
- A target hostname that resolves to a private IP cannot be detected at configuration time (only literals are checked)

### Local tests

```bash
cd mail-worker
pnpm install --frozen-lockfile
pnpm test        # local unit tests (vitest + miniflare local D1/KV, no remote writes)
pnpm run test:watch
```

> `pnpm test` is now the local unit test suite; the former "deploy to the test environment" script was renamed to
> `pnpm run deploy:test` (`wrangler deploy -c wrangler-test.toml`). Tests use the **local** bindings from
> `wrangler-test-local.toml`; never add `--remote` to unit tests.

Build artifacts: the `mail-vue` frontend builds with `--mode release` into `mail-worker/dist` (uploaded via the `assets.directory`
binding in `wrangler.toml`), and the Worker bundle is produced by `wrangler deploy`.

## Tech Stack

- **Platform**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web Framework**: [Hono](https://hono.dev/)

- **ORM**: [Drizzle](https://orm.drizzle.team/)

- **Frontend Framework**: [Vue3](https://vuejs.org/)

- **UI Framework**: [Element Plus](https://element-plus.org/)

- **Email Service**: [Resend](https://resend.com/)

- **Cache**: [Cloudflare KV](https://developers.cloudflare.com/kv/)

- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/)

- **File Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/)

## Project Structure

```
cloud-mail
├── mail-worker				    # Backend worker project
│   ├── src                  
│   │   ├── api	 			    # API layer
│   │   ├── const  			    # Project constants
│   │   ├── dao                 # Data access layer
│   │   ├── email			    # Email processing and handling
│   │   ├── entity			    # Database entities
│   │   ├── error			    # Custom exceptions
│   │   ├── hono			    # Web framework, middleware, error handling
│   │   ├── i18n			    # Internationalization
│   │   ├── init			    # Database and cache initialization
│   │   ├── model			    # Response data models
│   │   ├── security			# Authentication and authorization
│   │   ├── service			    # Business logic layer
│   │   ├── template			# Message templates
│   │   ├── utils			    # Utility functions
│   │   └── index.js			# Entry point
│   ├── package.json			# Project dependencies
│   └── wrangler.toml			# Project configuration
│
├─ mail-vue				        # Frontend Vue project
│   ├── src
│   │   ├── axios 			    # Axios configuration
│   │   ├── components			# Custom components
│   │   ├── echarts			    # ECharts integration
│   │   ├── i18n			    # Internationalization
│   │   ├── init			    # Startup initialization
│   │   ├── layout			    # Main layout components
│   │   ├── perm			    # Permissions and access control
│   │   ├── request			    # API request layer
│   │   ├── router			    # Router configuration
│   │   ├── store			    # Global state management
│   │   ├── utils			    # Utility functions
│   │   ├── views			    # Page components
│   │   ├── app.vue			    # Root component
│   │   ├── main.js			    # Entry JS file
│   │   └── style.css			# Global styles
│   ├── package.json			# Project dependencies
└── └── env.release				# Environment configuration

```

## Sponsor

<a href="https://doc.skymail.ink/support.html">
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## License

This project is licensed under the [MIT](LICENSE) license.

## Communication

[Telegram](https://t.me/cloud_mail_tg)
