// 翻译相关表的建表语句；初始化与单元测试共用，避免 SQL 漂移
const translationSchema = [
	`CREATE TABLE IF NOT EXISTS email_translation (
		job_id TEXT PRIMARY KEY NOT NULL,
		cache_key TEXT NOT NULL UNIQUE,
		user_id INTEGER NOT NULL,
		email_id INTEGER NOT NULL,
		source_hash TEXT NOT NULL,
		target_lang TEXT NOT NULL,
		model TEXT NOT NULL,
		prompt_version TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'pending',
		format_name TEXT NOT NULL DEFAULT 'html',
		content TEXT,
		text TEXT,
		fallback INTEGER NOT NULL DEFAULT 0,
		error_key TEXT,
		total_chunks INTEGER NOT NULL DEFAULT 0,
		done_chunks INTEGER NOT NULL DEFAULT 0,
		created_time INTEGER NOT NULL,
		update_time INTEGER NOT NULL,
		expire_time INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS email_translation_chunk (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		chunk_index INTEGER NOT NULL,
		status INTEGER NOT NULL DEFAULT 0,
		lease_owner TEXT,
		lease_until INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0,
		source_count INTEGER NOT NULL DEFAULT 0,
		result_json TEXT,
		FOREIGN KEY (job_id) REFERENCES email_translation(job_id)
	)`,
	`CREATE TABLE IF NOT EXISTS translation_quota (
		user_id INTEGER NOT NULL,
		day TEXT NOT NULL,
		jobs INTEGER NOT NULL DEFAULT 0,
		codepoints INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, day)
	)`,
	`CREATE TABLE IF NOT EXISTS translation_rate (
		user_id INTEGER NOT NULL,
		window_start INTEGER NOT NULL,
		count INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, window_start)
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_chunk_job ON email_translation_chunk(job_id, chunk_index)`,
	`CREATE INDEX IF NOT EXISTS idx_translation_job_user ON email_translation(user_id, email_id)`,
	`CREATE INDEX IF NOT EXISTS idx_translation_job_expire ON email_translation(expire_time)`
];

export default translationSchema;
