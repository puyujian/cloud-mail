<template>
  <div class="content-box" ref="contentBox">
    <div ref="container" class="content-html"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, nextTick } from 'vue'
import { sanitizeEmailHtml, extractBodyStyle, extractEmailCss } from '@/utils/sanitize-email-html.js'

const props = defineProps({
  html: {
    type: String,
    required: true
  }
})

const container = ref(null)
const contentBox = ref(null)
let shadowRoot = null
let shadowContent = null
let shadowMailStyle = null

function updateContent() {
  if (!shadowRoot) return;

  // 原文与译文共用同一套清洗规则；Shadow DOM 只隔离样式，不隔离脚本
  const safeHtml = sanitizeEmailHtml(props.html);
  const bodyStyle = extractBodyStyle(props.html);

  if (!shadowContent) {
    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          width: 100%;
          height: 100%;
          font-family: Inter, 'Helvetica Neue', Helvetica, 'PingFang SC',
                      'Hiragino Sans GB', 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: #13181D;
          word-break: break-word;
        }

        h1, h2, h3, h4 {
            font-size: 18px;
            font-weight: 700;
        }

        p {
          margin: 0;
        }

        a {
          text-decoration: none;
          color: #0E70DF;
        }

        .shadow-content {
          background: #FFFFFF;
          width: fit-content;
          height: fit-content;
          min-width: 100%;
        }

        img:not(table img) {
          max-width: 100%;
          height: auto !important;
        }

        /* 保留邮件里的代码块排版：换行与缩进不能被折叠 */
        pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-x: auto;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 13px;
        }

        code {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
      </style>
      <style class="mail-style"></style>
      <!-- 守卫样式必须排在邮件样式之后：邮件里的 :host 规则同权重，
           后写的才能压住它，把宿主锁回普通文档流布局 -->
      <style class="mail-guard">
        :host {
          position: static !important;
          z-index: auto !important;
          inset: auto !important;
          top: auto !important;
          right: auto !important;
          bottom: auto !important;
          left: auto !important;
          transform: none !important;
          filter: none !important;
          clip-path: none !important;
          pointer-events: auto !important;
        }
      </style>
      <div class="shadow-content"></div>
    `;
    shadowContent = shadowRoot.querySelector('.shadow-content');
    shadowMailStyle = shadowRoot.querySelector('.mail-style');
  }

  if (!shadowContent) return;

  // 邮件自带的 <style> 经过过滤后注入，保留 class 版式又不引入脚本
  if (shadowMailStyle) {
    const mailCss = extractEmailCss(props.html);
    if (shadowMailStyle.textContent !== mailCss) {
      shadowMailStyle.textContent = mailCss;
    }
  }

  shadowContent.innerHTML = safeHtml;
  if (bodyStyle) {
    shadowContent.setAttribute('style', bodyStyle);
  } else {
    shadowContent.removeAttribute('style');
  }
}

function autoScale() {
  if (!shadowRoot || !contentBox.value) return

  const parent = contentBox.value
  const shadowContentEl = shadowRoot.querySelector('.shadow-content')

  if (!shadowContentEl) return

  const parentWidth = parent.offsetWidth
  const childWidth = shadowContentEl.scrollWidth

  if (childWidth === 0) return

  const scale = parentWidth / childWidth

  const hostElement = shadowRoot.host
  hostElement.style.zoom = scale
}

onMounted(() => {
  shadowRoot = container.value.attachShadow({ mode: 'open' })
  updateContent()
  nextTick(() => autoScale())
})

watch(() => props.html, () => {
  updateContent()
  nextTick(() => autoScale())
})
</script>

<style scoped>
.content-box {
  width: 100%;
  height: 100%;
  overflow: hidden;
  /* 纵深防御：contain:paint 让 fixed/sticky 后代以本容器为包含块并被裁掉，
     不依赖 CSS 文本过滤，即使过滤被绕过也盖不住应用界面 */
  contain: paint;
  position: relative;
  isolation: isolate;
  font-family: Inter, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", Arial, sans-serif;
}

.content-html {
  width: 100%;
  height: 100%;
}
</style>
