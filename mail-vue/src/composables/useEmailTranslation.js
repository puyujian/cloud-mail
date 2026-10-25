import { ref, computed, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingStore } from '@/store/setting.js'
import { emailTranslateStart, emailTranslateStep } from '@/request/email.js'

// 会话内缓存：key = emailId|lang|sourceHash，value = { format, content, text, fallback }
// 必须带源哈希，否则同一邮件被更新（或不同账号复用同一 emailId）时会命中旧译文
const resultCache = new Map()
const MAX_CACHE = 20
// 单次翻译的轮询墙钟上限（毫秒），超时后由用户手动重试
const POLL_DEADLINE_MS = 180 * 1000

function cacheKey(emailId, lang, sourceHash) {
  return emailId + '|' + lang + '|' + (sourceHash || '')
}

function putCache(key, value) {
  if (resultCache.has(key)) {
    resultCache.delete(key)
  }
  resultCache.set(key, value)
  while (resultCache.size > MAX_CACHE) {
    const first = resultCache.keys().next().value
    resultCache.delete(first)
  }
}

// 服务端 BizError 发的是小驼峰 errorKey（translationRateLimited），
// 旧写法是大写下划线。键统一做「去分隔符 + 小写」归一化，两种都能命中，
// 否则映射永远对不上，线上只剩一句“翻译失败，请重试”。
const ERROR_KEY_MAP = {
  translationratelimited: 'translationRateLimited',
  translationquotaexceeded: 'translationQuotaExceeded',
  translationtoolarge: 'translationTooLarge',
  translationtimeout: 'translationTimeout',
  translationaiunavailable: 'translationUnavailable',
  translationmodelfailed: 'translationUnavailable',
  translationinvalidoutput: 'translationUnavailable',
  translationunavailable: 'translationUnavailable',
  translationempty: 'translationNoText',
  translationnotfound: 'translationNotFound',
  translationforbidden: 'translationForbidden',
  translationsourcechanged: 'translationSourceChanged',
  translationjobexpired: 'translationFailed',
  translationinvalidparams: 'translationFailed',
  translationcachefailed: 'translationFailed',
  translationlanguageunsupported: 'translationFailed'
}

export function useEmailTranslation(emailRef) {
  const { t } = useI18n()
  const settingStore = useSettingStore()

  const status = ref('idle')
  const selectedLang = ref('auto')
  const showOriginal = ref(false)
  const result = ref(null)
  const progress = ref({ done: 0, total: 0 })
  const errorMessage = ref('')
  const activeLang = ref('')

  let epoch = 0
  let running = false
  // 记录当前展示译文对应的服务端源哈希，供缓存键与语言切换复用
  let activeHash = ''

  const resolvedLang = computed(() => {
    if (selectedLang.value === 'auto') {
      return settingStore.lang === 'zh' ? 'zh' : 'en'
    }
    return selectedLang.value
  })

  const isTranslated = computed(() => status.value === 'done' && !!result.value && !showOriginal.value)

  const loading = computed(() => status.value === 'loading')

  function reset() {
    epoch += 1
    running = false
    activeHash = ''
    status.value = 'idle'
    showOriginal.value = false
    result.value = null
    errorMessage.value = ''
    activeLang.value = ''
    progress.value = { done: 0, total: 0 }
  }

  function applyPayload(payload, lang) {
    result.value = {
      format: payload.format || 'html',
      content: payload.content || '',
      text: payload.text || '',
      fallback: !!payload.fallback
    }
    status.value = 'done'
    showOriginal.value = false
    activeLang.value = lang
    // 缓存键带上服务端返回的源哈希：正文一改就不再命中旧译文
    activeHash = payload.sourceHash || ''
    putCache(cacheKey(emailRef.value?.emailId, lang, activeHash), result.value)
  }

  function toMessage(error) {
    const rawKey = error?.errorKey || error?.data?.errorKey || ''
    const key = String(rawKey).replace(/[\s_-]/g, '').toLowerCase()
    if (key && ERROR_KEY_MAP[key]) {
      return t(ERROR_KEY_MAP[key])
    }
    // 服务端失败统一返回 HTTP 200，真正的状态码在 body 的 code 上
    const bizCode = error?.code || error?.data?.code
    if (bizCode === 401) return t('translationLoginExpired')
    if (bizCode === 403) return t('translationForbidden')
    if (bizCode === 429) return t('translationRateLimited')
    if (bizCode === 413) return t('translationTooLarge')
    if (bizCode === 504) return t('translationTimeout')
    // 没有映射时带上服务端原话：否则线上只有“翻译失败”，
    // 分不清是模型超时、额度用尽还是数据库缺表
    const body = error?.isAxiosError || error?.config || error?.request ? null : error
    const message = body?.message || body?.data?.message || ''
    if (typeof message === 'string' && message.trim()
      && !/D1_ERROR|SQLITE|no such (table|column)|TypeError|is not a function/i.test(message)) {
      return message
    }
    return t('translationFailed')
  }

  async function translate() {
    const current = emailRef.value
    if (!current?.emailId || running) return

    const lang = resolvedLang.value
    const myEpoch = epoch

    running = true
    status.value = 'loading'
    errorMessage.value = ''
    progress.value = { done: 0, total: 0 }

    try {
      let payload = await emailTranslateStart({ emailId: current.emailId, targetLang: lang })
      if (myEpoch !== epoch) return

      progress.value = { done: payload.progress?.done || 0, total: payload.progress?.total || 0 }

      // 服务端返回的源哈希才是可信的缓存凭证：命中就省掉整轮 step
      const cached = resultCache.get(cacheKey(current.emailId, lang, payload.sourceHash))
      if (cached) {
        applyPayload(Object.assign({}, cached, { sourceHash: payload.sourceHash }), lang)
        return
      }

      if (payload.state === 'done') {
        applyPayload(payload, lang)
        return
      }

      // 轮询预算：按分块数放大，并用墙钟兜底，避免 busy 退避把次数耗尽
      const deadline = Date.now() + POLL_DEADLINE_MS
      let guard = 0
      let maxGuard = 64
      while (payload.state !== 'done') {
        if (myEpoch !== epoch) return
        guard += 1
        const total = payload.progress?.total || 1
        maxGuard = Math.max(64, total * 8)
        if (guard > maxGuard || Date.now() > deadline) {
          throw { errorKey: 'TRANSLATION_TIMEOUT' }
        }
        payload = await emailTranslateStep(payload.jobId)
        if (myEpoch !== epoch) return
        progress.value = { done: payload.progress?.done || 0, total: payload.progress?.total || 0 }
        if (payload.state === 'error') {
          throw { errorKey: payload.errorKey || 'TRANSLATION_UNAVAILABLE' }
        }
        // 分块正被并发请求持有：退避后再试，避免空转打满接口
        if (payload.busy) {
          await new Promise(resolve => setTimeout(resolve, 800))
        }
      }
      applyPayload(payload, lang)
    } catch (e) {
      if (myEpoch !== epoch) return
      status.value = 'error'
      errorMessage.value = toMessage(e)
    } finally {
      if (myEpoch === epoch) {
        running = false
      }
    }
  }

  function restoreOriginal() {
    showOriginal.value = true
  }

  function showTranslation() {
    if (status.value === 'done' && result.value) {
      showOriginal.value = false
    }
  }

  function retry() {
    errorMessage.value = ''
    translate()
  }

  watch(() => emailRef.value?.emailId, () => {
    reset()
  })

  // 同一封邮件正文被重新拉取（例如刷新、重新打开）时源哈希会变，旧译文立即失效
  watch(() => [emailRef.value?.content, emailRef.value?.text].join('\u0000'), (next, prev) => {
    if (next === prev) return
    if (status.value === 'done' || status.value === 'loading') reset()
  })

  // auto 模式依赖 UI 语言：语言切换后旧译文的目标语言已过期，必须失效重译
  watch(resolvedLang, (next, prev) => {
    if (next === prev) return
    if (status.value !== 'done' && status.value !== 'loading') return
    // 无论是否命中缓存，都必须递增 epoch：否则上一个语言的在途请求回包会覆盖新语言
    epoch += 1
    running = false
    const hash = activeHash
    const cached = resultCache.get(cacheKey(emailRef.value?.emailId, next, hash))
    if (cached) {
      result.value = cached
      showOriginal.value = false
      activeLang.value = next
      status.value = 'done'
    } else {
      activeHash = ''
      result.value = null
      errorMessage.value = ''
      progress.value = { done: 0, total: 0 }
      status.value = 'idle'
    }
  })

  watch(selectedLang, () => {
    if (status.value === 'done') {
      const lang = resolvedLang.value
      const cached = resultCache.get(cacheKey(emailRef.value?.emailId, lang, activeHash))
      if (cached) {
        result.value = cached
        showOriginal.value = false
        activeLang.value = lang
      } else {
        status.value = 'idle'
        result.value = null
      }
    }
  })

  onUnmounted(() => {
    epoch += 1
  })

  return {
    status,
    loading,
    isTranslated,
    selectedLang,
    resolvedLang,
    activeLang,
    showOriginal,
    result,
    progress,
    errorMessage,
    translate,
    restoreOriginal,
    showTranslation,
    retry,
    reset
  }
}

export default useEmailTranslation