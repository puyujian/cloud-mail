/**
 * SyncClipboard 集成新增的 setting 列定义（唯一来源）。
 *
 * 使用者：
 *   - src/init/init.js 的 v3_4DB（部署后 /init 迁移）
 *   - scripts/migrate-sync-clipboard.mjs（独立幂等迁移工具，本地/远程）
 *
 * 列名与类型都是代码内常量（非外部输入），可安全拼接进 DDL。
 */
export const SETTING_TABLE = 'setting';

export const SYNC_CLIPBOARD_COLUMNS = {
	sync_clipboard_status: 'INTEGER NOT NULL DEFAULT 1',
	sync_clipboard_url: "TEXT NOT NULL DEFAULT ''",
	sync_clipboard_username: "TEXT NOT NULL DEFAULT ''",
	sync_clipboard_password: "TEXT NOT NULL DEFAULT ''",
	sync_clipboard_mode: 'INTEGER NOT NULL DEFAULT 0',
	sync_clipboard_emails: "TEXT NOT NULL DEFAULT ''",
	sync_clipboard_retry: 'INTEGER NOT NULL DEFAULT 2',
	sync_clipboard_timeout: 'INTEGER NOT NULL DEFAULT 5000'
};

export default SYNC_CLIPBOARD_COLUMNS;
