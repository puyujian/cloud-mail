import translationConst from '../const/translation-const';
import translationSchema from '../const/translation-schema';

// 只保留今天与昨天之前的配额行会被清掉，这里给 cron 一个安全的日期下界
function quotaDayBefore(now) {
	return new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 部署（wrangler deploy / Workers Builds）不会执行 /api/init，翻译表必须能自愈，
// 否则线上第一次翻译就是 D1_ERROR: no such table。DDL 全部幂等，
// 每个 isolate 首次翻译请求做一次，失败不缓存，下个请求会重试。
let schemaReady = false;
let schemaPromise = null;

function ensureTranslationSchema(c) {
	if (schemaReady) {
		return Promise.resolve(true);
	}
	if (!schemaPromise) {
		schemaPromise = (async () => {
			// 逐条执行而不是整批 batch：一条建索引失败不该连带把建表也回滚掉，
			// 线上已经出现过“权限行在、表不在”的半初始化状态
			let tableFailed = false;
			for (const sql of translationSchema) {
				try {
					await c.env.db.prepare(sql).run();
				} catch (e) {
					console.error('翻译表自愈失败', e?.message);
					if (/^\s*CREATE\s+TABLE/i.test(sql)) {
						tableFailed = true;
					}
				}
			}
			try {
				// 与 init 的 v3_4DB 保持同一份语句：缺权限行时工具栏按钮不显示
				await c.env.db.prepare(`
					INSERT INTO perm (name, perm_key, pid, type, sort)
					SELECT '邮件翻译', 'email:translate', 1, 2, 2
					WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'email:translate')
				`).run();
			} catch (e) {
				console.warn('翻译权限自愈失败', e?.message);
			}
			// 建表没成功就不标记完成，下个请求会重试
			schemaReady = !tableFailed;
			return schemaReady;
		})().finally(() => {
			if (!schemaReady) {
				schemaPromise = null;
			}
		});
	}
	return schemaPromise;
}

const db = {

	ensureSchema(c) {
		return ensureTranslationSchema(c);
	},

	prepare(c, sql, ...params) {
		return c.env.db.prepare(sql).bind(...params);
	},

	// 用 RETURNING 一次拿到写入行：先 run 再 select 会在两条语句之间留出失败窗口，
	// 那时任务已经落库、调用方却按失败退了配额，重试就能白拿一次翻译
	async insertJob(c, job) {
		const row = await c.env.db.prepare(`
			INSERT INTO email_translation (
				job_id, cache_key, user_id, email_id, source_hash, target_lang, model,
				prompt_version, state, format_name, total_chunks, done_chunks, created_time, update_time, expire_time
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
			ON CONFLICT(cache_key) DO NOTHING
			RETURNING *
		`).bind(
			job.jobId, job.cacheKey, job.userId, job.emailId, job.sourceHash, job.targetLang,
			job.model, job.promptVersion, translationConst.STATE.PENDING, job.format,
			job.totalChunks, job.now, job.now, job.expireTime
		).first();
		if (row) {
			return row;
		}
		// 唯一键冲突时 INSERT 不返回行，此时任务属于并发请求，读回来复用
		return await this.selectJobByCacheKey(c, job.cacheKey);
	},

	// 只有把状态从非 done 改为 done 的那一次收尾算成功，避免并发重复写终态
	// 完成与缓存键一起写：分两步写的话，并发的 start() 会在这中间读到 done
	// 并把兜底产物当成主力结果回灌进 KV，之后就再也擦不掉了
	async markDone(c, jobId, patch) {
		const sets = ['state = ?', 'format_name = ?', 'content = ?', 'text = ?', 'fallback = ?', 'update_time = ?'];
		const params = [
			translationConst.STATE.DONE, patch.format_name, patch.content, patch.text,
			patch.fallback, Date.now()
		];
		if (patch.cache_key) {
			sets.push('cache_key = ?');
			params.push(patch.cache_key);
		}
		params.push(jobId, translationConst.STATE.DONE);
		const row = await c.env.db.prepare(`
			UPDATE email_translation SET ${sets.join(', ')}
			WHERE job_id = ? AND state <> ?
			RETURNING job_id
		`).bind(...params).first();
		return row;
	},

	// 换一个缓存键：兜底通道产出的结果不能被当成主力通道的缓存复用
	async rekeyJob(c, jobId, cacheKey) {
		await c.env.db.prepare(
			`UPDATE email_translation SET cache_key = ?, update_time = ? WHERE job_id = ?`
		).bind(cacheKey, Date.now(), jobId).run();
	},

	async selectJobByCacheKey(c, cacheKey) {
		return await c.env.db.prepare(`SELECT * FROM email_translation WHERE cache_key = ?`).bind(cacheKey).first();
	},

	async selectJob(c, jobId, userId) {
		return await c.env.db.prepare(
			`SELECT * FROM email_translation WHERE job_id = ? AND user_id = ?`
		).bind(jobId, userId).first();
	},

	async updateJobState(c, jobId, state, patch = {}) {
		const sets = ['state = ?', 'update_time = ?'];
		const params = [state, Date.now()];
		for (const key of ['format_name', 'content', 'text', 'fallback', 'error_key', 'model']) {
			if (patch[key] !== undefined) {
				sets.push(key + ' = ?');
				params.push(patch[key]);
			}
		}
		params.push(jobId, translationConst.STATE.DONE, translationConst.STATE.ERROR);
		// 终态不可回退：done / error 都不能被并发 step 改回 running。
		// 只挡 done 的话，迟到的请求会把已判死的任务拉回运行态，随后再判死退款一次
		await c.env.db.prepare(
			`UPDATE email_translation SET ${sets.join(', ')} WHERE job_id = ? AND state <> ? AND state <> ?`
		).bind(...params).run();
	},

	async insertChunks(c, jobId, chunks) {
		const statements = chunks.map((chunk, index) => c.env.db.prepare(
			`INSERT INTO email_translation_chunk (job_id, chunk_index, status, lease_owner, lease_until, attempts, source_count)
			 VALUES (?, ?, 0, NULL, NULL, 0, ?)
			 ON CONFLICT(job_id, chunk_index) DO NOTHING`
		).bind(jobId, index, chunk.length));
		if (statements.length === 0) return;
		await c.env.db.batch(statements);
	},

	async selectChunks(c, jobId) {
		const { results } = await c.env.db.prepare(
			`SELECT chunk_index, status, result_json FROM email_translation_chunk WHERE job_id = ? ORDER BY chunk_index`
		).bind(jobId).all();
		return results || [];
	},

	async claimChunk(c, jobId, owner, now) {
		const row = await c.env.db.prepare(`
			UPDATE email_translation_chunk
			SET status = 1, lease_owner = ?, lease_until = ?, attempts = attempts + 1
			WHERE id = (
				SELECT id FROM email_translation_chunk
				WHERE job_id = ?
					AND status IN (0, 1, 3)
					AND (lease_until IS NULL OR lease_until < ?)
					AND attempts < 3
					AND EXISTS (
						SELECT 1 FROM email_translation job
						WHERE job.job_id = email_translation_chunk.job_id
							AND job.state NOT IN ('done', 'error')
					)
				ORDER BY chunk_index
				LIMIT 1
			)
			RETURNING *
		`).bind(owner, now + translationConst.LEASE_MS, jobId, now).first();
		return row;
	},

	async finishChunk(c, chunkId, owner, resultJson, status) {
		const row = await c.env.db.prepare(`
			UPDATE email_translation_chunk
			SET status = ?, result_json = ?, lease_owner = NULL, lease_until = NULL
			WHERE id = ? AND lease_owner = ?
			RETURNING id
		`).bind(Number(status), resultJson, chunkId, owner).first();
		return !!row;
	},

	async releaseChunk(c, chunkId, owner, retryable) {
		// 结果未知的失败（超时）不再自动重试，避免重复计费；attempts 直接耗尽
		await c.env.db.prepare(`
			UPDATE email_translation_chunk
			SET status = 3, lease_owner = NULL, lease_until = NULL,
				attempts = CASE WHEN ? = 1 THEN attempts ELSE 3 END
			WHERE id = ? AND lease_owner = ?
		`).bind(retryable === false ? 0 : 1, chunkId, owner).run();
	},

	async deleteJob(c, jobId) {
		await c.env.db.prepare(`DELETE FROM email_translation_chunk WHERE job_id = ?`).bind(jobId).run();
		await c.env.db.prepare(`DELETE FROM email_translation WHERE job_id = ?`).bind(jobId).run();
	},

	async countClaimable(c, jobId, now) {
		const row = await c.env.db.prepare(`
			SELECT COUNT(*) AS total FROM email_translation_chunk
			WHERE job_id = ? AND status IN (0, 1, 3)
				AND (lease_until IS NULL OR lease_until < ?)
				AND attempts < 3
		`).bind(jobId, now).first();
		return Number(row?.total || 0);
	},

	async countExhausted(c, jobId, now) {
		const row = await c.env.db.prepare(`
			SELECT COUNT(*) AS total FROM email_translation_chunk
			WHERE job_id = ? AND status <> 2 AND attempts >= 3
				AND (lease_until IS NULL OR lease_until < ?)
		`).bind(jobId, now).first();
		return Number(row?.total || 0);
	},

	// 正被其他请求持有租约的分块：判断任务是否真的卡死时必须排除它们
	async countInflight(c, jobId, now) {
		const row = await c.env.db.prepare(`
			SELECT COUNT(*) AS total FROM email_translation_chunk
			WHERE job_id = ? AND status = 1 AND lease_until IS NOT NULL AND lease_until >= ?
		`).bind(jobId, now).first();
		return Number(row?.total || 0);
	},

	async countChunkState(c, jobId) {
		const row = await c.env.db.prepare(`
			SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS done,
				SUM(CASE WHEN status IN (0, 1, 3) THEN 1 ELSE 0 END) AS unfinished
			FROM email_translation_chunk WHERE job_id = ?
		`).bind(jobId).first();
		return {
			total: Number(row?.total || 0),
			done: Number(row?.done || 0),
			unfinished: Number(row?.unfinished || 0)
		};
	},

	// 进度只能单调前进：并发 step 里迟到的旧计数不能把已完成数改回去
	async updateProgress(c, jobId, done, total) {
		await c.env.db.prepare(
			`UPDATE email_translation
			 SET done_chunks = ?, total_chunks = ?, update_time = ?
			 WHERE job_id = ? AND done_chunks <= ? AND state <> ?`
		).bind(done, total, Date.now(), jobId, Number(done), translationConst.STATE.DONE).run();
	},

	// 原子占用配额：超过上限时不返回行（并发安全，无需先读后写）
	// 只有「第一次」把任务判死才算失败：并发 step 同时失败时不能重复退额度
	// 只写错误码，不碰 state：迟到的并发 step 一旦把 error 改回 running，
	// 下一次失败会再走一遍 failJob，把别人的额度也退掉
	async touchJobErrorKey(c, jobId, errorKey) {
		await c.env.db.prepare(
			`UPDATE email_translation SET error_key = ?, update_time = ?
			 WHERE job_id = ? AND state <> ? AND state <> ?`
		).bind(
			errorKey || 'translationModelFailed', Date.now(),
			jobId, translationConst.STATE.DONE, translationConst.STATE.ERROR
		).run();
	},

	async markJobErrorOnce(c, jobId, errorKey) {
		const result = await c.env.db.prepare(`
			UPDATE email_translation SET state = ?, error_key = ?, update_time = ?
			WHERE job_id = ? AND state <> ? AND state <> ?
		`).bind(
			translationConst.STATE.ERROR, errorKey || 'translationModelFailed', Date.now(),
			jobId, translationConst.STATE.DONE, translationConst.STATE.ERROR
		).run();
		return Number(result?.meta?.changes || 0) > 0;
	},

	async addQuota(c, userId, day, codepoints, maxJobs, maxCodepoints) {
		const row = await c.env.db.prepare(`
			INSERT INTO translation_quota (user_id, day, jobs, codepoints)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(user_id, day) DO UPDATE SET
				jobs = translation_quota.jobs + 1,
				codepoints = translation_quota.codepoints + excluded.codepoints
			WHERE translation_quota.jobs + 1 <= ?
				AND translation_quota.codepoints + excluded.codepoints <= ?
			RETURNING jobs, codepoints
		`).bind(userId, day, codepoints, maxJobs, maxCodepoints).first();
		return row;
	},

	// 退还配额：任务最终没有创建成功时把预占的额度还回去
	async releaseQuota(c, userId, day, codepoints) {
		await c.env.db.prepare(`
			UPDATE translation_quota
			SET jobs = MAX(jobs - 1, 0), codepoints = MAX(codepoints - ?, 0)
			WHERE user_id = ? AND day = ?
		`).bind(codepoints, userId, day).run();
	},

	// 每分钟新建任务数限制：计数表 + 原子 UPSERT，避免 count→insert 之间的并发窗口
	async addRate(c, userId, windowStart, max) {
		const row = await c.env.db.prepare(`
			INSERT INTO translation_rate (user_id, window_start, count)
			VALUES (?, ?, 1)
			ON CONFLICT(user_id, window_start) DO UPDATE SET
				count = translation_rate.count + 1
			WHERE translation_rate.count + 1 <= ?
			RETURNING count
		`).bind(userId, windowStart, max).first();
		return row;
	},

	// 本次没有真正建成任务时把限流名额退回去
	async releaseRate(c, userId, windowStart) {
		await c.env.db.prepare(
			`UPDATE translation_rate SET count = MAX(count - 1, 0)
			 WHERE user_id = ? AND window_start = ?`
		).bind(userId, windowStart).run();
	},

	async cleanExpired(c, now) {
		// D1 单个查询最多 100 个绑定参数，IN (...) 的占位符也算在内，
		// 因此每批清理的任务数固定为 100，不能靠调用方放大
		const batch = translationConst.CLEAN_BATCH_SIZE;
		let removed = 0;
		// 先用集合事务删子表再删父表：chunk 有 FOREIGN KEY 指向 job，
		// 顺序反过来会直接 FOREIGN KEY constraint failed，整批清理都做不成
		for (let round = 0; round < 25; round++) {
			// 25 轮 × 100 条足以在一次 cron 内清完积压，剩下的下个整点继续
			const { results } = await c.env.db.prepare(
				`SELECT job_id FROM email_translation WHERE expire_time < ? LIMIT ?`
			).bind(now, batch).all();
			const ids = (results || []).map(row => row.job_id);
			if (ids.length === 0) break;
			const marks = ids.map(() => '?').join(', ');
			await c.env.db.batch([
				c.env.db.prepare(`DELETE FROM email_translation_chunk WHERE job_id IN (${marks})`).bind(...ids),
				c.env.db.prepare(`DELETE FROM email_translation WHERE job_id IN (${marks})`).bind(...ids)
			]);
			removed += ids.length;
			if (ids.length < batch) break;
		}
		// 兜底清理历史遗留的孤儿分块
		await c.env.db.prepare(
			`DELETE FROM email_translation_chunk WHERE job_id NOT IN (SELECT job_id FROM email_translation)`
		).run();
		// 旧限流窗口与旧配额日期不再需要保留
		await c.env.db.batch([
			c.env.db.prepare(`DELETE FROM translation_rate WHERE window_start < ?`).bind(Math.floor(now / 60000) - 120),
			c.env.db.prepare(`DELETE FROM translation_quota WHERE day < ?`).bind(quotaDayBefore(now))
		]);
		return removed;
	}
};

export default db;
