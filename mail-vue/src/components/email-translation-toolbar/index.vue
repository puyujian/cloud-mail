<template>
  <div class="translation-toolbar">
    <el-select
        v-model="selectedLang"
        size="small"
        class="lang-select"
        :disabled="loading"
    >
      <el-option :label="$t('translationFollowUi')" value="auto"/>
      <el-option :label="$t('translationLanguageZh')" value="zh"/>
      <el-option :label="$t('translationLanguageEn')" value="en"/>
    </el-select>

    <el-button
        v-if="status !== 'done'"
        size="small"
        type="primary"
        plain
        :loading="loading"
        @click="$emit('translate')"
    >
      {{ loading ? $t('translationLoading') : $t('translateEmail') }}
    </el-button>

    <template v-else>
      <el-button
          v-if="!showOriginal"
          size="small"
          plain
          @click="$emit('restore')"
      >
        {{ $t('translationShowOriginal') }}
      </el-button>
      <el-button
          v-else
          size="small"
          type="primary"
          plain
          @click="$emit('showTranslation')"
      >
        {{ $t('translationShowTranslated') }}
      </el-button>
    </template>

    <span v-if="loading && progress.total > 0" class="hint">
      {{ $t('translationProgress', { done: progress.done, total: progress.total }) }}
    </span>

    <span v-else-if="status === 'done' && fallback" class="hint">
      {{ $t('translationFormatFallback') }}
    </span>

    <span v-else-if="status === 'done'" class="hint">
      {{ $t('translationNotice') }}
    </span>

    <span v-if="status === 'error'" class="error">
      {{ errorMessage }}
      <el-link type="primary" :underline="false" @click="$emit('retry')">
        {{ $t('translationRetry') }}
      </el-link>
    </span>
  </div>
</template>

<script setup>
defineProps({
  status: { type: String, default: 'idle' },
  loading: { type: Boolean, default: false },
  showOriginal: { type: Boolean, default: false },
  progress: { type: Object, default: () => ({ done: 0, total: 0 }) },
  fallback: { type: Boolean, default: false },
  errorMessage: { type: String, default: '' }
})

const selectedLang = defineModel('selectedLang', { type: String, default: 'auto' })

defineEmits(['translate', 'restore', 'showTranslation', 'retry'])
</script>

<style scoped lang="scss">
.translation-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;

  .lang-select {
    width: 132px;
  }

  .hint {
    font-size: 12px;
    color: var(--secondary-text-color);
  }

  .error {
    font-size: 12px;
    color: var(--el-color-danger);
    display: flex;
    align-items: center;
    gap: 6px;
  }
}
</style>
