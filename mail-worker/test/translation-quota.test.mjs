import { describe, it, expect } from 'vitest';
import translationService from '../src/service/email-translation-service';
import translationRepository from '../src/repository/translation-repository';

// 评审回归：INSERT 与回读之间失败时不能让任务悬空（配额已扣却从未计费）
describe('翻译配额一致性', () => {
	it('insertJob 用 RETURNING 一条语句拿到写入行', async () => {
		let captured = '';
		const c = {
			env: {
				db: {
					prepare: (sql) => {
						captured = sql;
						return { bind: () => ({ first: async () => ({ job_id: 'j1' }) }) };
					}
				}
			}
		};
		const row = await translationRepository.insertJob(c, {
			jobId: 'j1', cacheKey: 'k', userId: 1, emailId: 2, sourceHash: 'h',
			targetLang: 'zh', model: 'm', promptVersion: 'v', format: 'html',
			totalChunks: 1, now: 1, expireTime: 2
		});
		expect(captured).toContain('RETURNING');
		expect(row.job_id).toBe('j1');
	});

	it('写入抛错但任务已落库时按复用处理，不退配额', async () => {
		const calls = [];
		const originals = {};
		const patch = (name, impl) => {
			originals[name] = translationRepository[name];
			translationRepository[name] = impl;
		};

		// 写入成功后连接断掉：行已经在库里，只有响应丢了
		let written = null;
		patch('selectJobByCacheKey', async () => (calls.includes('insertAttempt') ? written : null));
		patch('addRate', async () => { calls.push('rate'); return { count: 1 }; });
		patch('addQuota', async () => { calls.push('quota'); return { jobs: 1, codepoints: 5 }; });
		patch('insertJob', async (c, job) => {
			calls.push('insertAttempt');
			written = {
				job_id: job.jobId, cache_key: job.cacheKey, user_id: job.userId,
				state: 'pending', total_chunks: job.totalChunks, source_hash: job.sourceHash,
				target_lang: job.targetLang, expire_time: job.expireTime
			};
			throw new Error('connection reset after commit');
		});
		patch('releaseQuota', async () => { calls.push('releaseQuota'); });
		patch('releaseRate', async () => { calls.push('releaseRate'); });
		patch('insertChunks', async () => { calls.push('insertChunks'); });

		const origReadable = translationService.readableEmail;
		const origPlan = translationService.buildPlan;
		translationService.readableEmail = async () => ({ content: '<p>Hi</p>', text: 'Hi' });
		translationService.buildPlan = async () => ({
			format: 'html', fallbackSource: false, document: null,
			units: [{ id: 'n0001', text: 'Hi' }], chunks: [[{ id: 'n0001', text: 'Hi' }]],
			plain: '', sourceHash: 'h'
		});

		try {
			const c = {
				env: {
					kv: {},
					db: {
						// selectJob / 其余读回都从「已落库」视角返回
						prepare: () => ({
							bind: () => ({
								first: async () => written,
								all: async () => ({ results: [] }),
								run: async () => ({ success: true })
							})
						}),
						batch: async (list) => list
					}
				}
			};
			const payload = await translationService.start(c, { emailId: 2, targetLang: 'zh' }, 1);
			if (!payload.jobId) throw new Error('no reusing: ' + JSON.stringify(calls));
			expect(payload.jobId).toBe(written.job_id);
			expect(calls).not.toContain('releaseQuota');
			expect(calls).not.toContain('releaseRate');
		} finally {
			for (const [name, fn] of Object.entries(originals)) translationRepository[name] = fn;
			translationService.readableEmail = origReadable;
			translationService.buildPlan = origPlan;
		}
	});
});
