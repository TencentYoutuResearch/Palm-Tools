<script lang="ts" module>
  /**
   * Icon.svelte —— 全站统一的 stroke 线条图标组件,lucide 视觉语言。
   *
   * 设计要点:
   * - 单文件、零依赖,所有 path 写在 PATHS 表里。
   * - size 默认 'em' (1em),自动跟随 font-size;颜色走 currentColor。
   * - viewBox 统一 24×24,stroke-width 默认 1.75,圆角 round/round。
   * - 加新图标的方法:在 PATHS 表追加 `name: '<path d="…"/>…'`,svg 内嵌片段即可。
   *   保持单色 stroke 线条风格,不要 fill。
   *
   * 命名遵循 lucide:
   *   https://lucide.dev/icons —— 没有就找最接近的同义词,不自创。
   */
  export type IconName =
    | 'check'
    | 'x'
    | 'plus'
    | 'brain'
    | 'alert-triangle'
    | 'lock'
    | 'list-checks'
    | 'ban'
    | 'zap'
    | 'pencil'
    | 'star'
    | 'octagon-x'
    | 'construction'
    | 'link'
    | 'copy'
    | 'archive'
    | 'search'
    | 'folder'
    | 'folder-open'
    | 'file-text'
    | 'eye'
    | 'external-link'
    | 'git-branch'
    | 'bell'
    | 'trash-2'
    | 'panel-right'
    | 'panel-right-open'
    | 'refresh-cw'
    | 'chevron-down'
    | 'chevron-right'
    | 'more-horizontal'
    | 'maximize-2'
    | 'minimize-2'

  /// 24×24 viewBox 下的 stroke path 片段。新增图标在这里加。
  /// 内容不包括 <svg> 外层 —— 由组件统一加。
  const PATHS: Record<IconName, string> = {
    // lucide:check
    check: '<polyline points="20 6 9 17 4 12"/>',
    // lucide:x
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    // lucide:plus
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    // lucide:brain (简化版,只保留主轮廓)
    brain:
      '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>' +
      '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>',
    // lucide:triangle-alert
    'alert-triangle':
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>',
    // lucide:lock
    lock:
      '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    // lucide:list-checks
    'list-checks':
      '<line x1="10" y1="6" x2="21" y2="6"/>' +
      '<line x1="10" y1="12" x2="21" y2="12"/>' +
      '<line x1="10" y1="18" x2="21" y2="18"/>' +
      '<polyline points="3 6 4 7 6 5"/>' +
      '<polyline points="3 12 4 13 6 11"/>' +
      '<polyline points="3 18 4 19 6 17"/>',
    // lucide:ban
    ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    // lucide:zap
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    // lucide:pencil
    pencil:
      '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>' +
      '<path d="m15 5 4 4"/>',
    // lucide:star
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    // lucide:octagon-x (用作 blacklist 强禁)
    'octagon-x':
      '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>' +
      '<line x1="15" y1="9" x2="9" y2="15"/>' +
      '<line x1="9" y1="9" x2="15" y2="15"/>',
    // lucide:construction (用作 dead_end / 进行中)
    construction:
      '<rect x="2" y="6" width="20" height="8" rx="1"/>' +
      '<path d="M17 14v7"/><path d="M7 14v7"/>' +
      '<path d="M17 3v3"/><path d="M7 3v3"/>' +
      '<path d="M10 14 2.3 6.3"/><path d="m14 6 7.7 7.7"/>' +
      '<path d="m8 6 8 8"/>',
    // lucide:link
    link:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    // lucide:copy
    copy:
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    // lucide:archive
    archive:
      '<rect x="2" y="3" width="20" height="5" rx="1"/>' +
      '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>' +
      '<line x1="10" y1="12" x2="14" y2="12"/>',
    // lucide:search
    search:
      '<circle cx="11" cy="11" r="8"/>' +
      '<line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    // lucide:folder
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    // lucide:folder-open
    'folder-open':
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.46 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2A2 2 0 0 0 12.1 6H20a2 2 0 0 1 2 2v2"/>',
    // lucide:file-text
    'file-text':
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
      '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
      '<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    // lucide:eye
    eye:
      '<path d="M2.06 12.35a1 1 0 0 1 0-.7A10.75 10.75 0 0 1 12 5a10.75 10.75 0 0 1 9.94 6.65 1 1 0 0 1 0 .7A10.75 10.75 0 0 1 12 19a10.75 10.75 0 0 1-9.94-6.65Z"/>' +
      '<circle cx="12" cy="12" r="3"/>',
    // lucide:external-link
    'external-link':
      '<path d="M15 3h6v6"/>' +
      '<path d="M10 14 21 3"/>' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    // lucide:git-branch
    'git-branch':
      '<line x1="6" y1="3" x2="6" y2="15"/>' +
      '<circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>' +
      '<path d="M18 9a9 9 0 0 1-9 9"/>',
    // lucide:bell
    bell:
      '<path d="M10.268 21a2 2 0 0 0 3.464 0"/>' +
      '<path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326"/>',
    // lucide:trash-2
    'trash-2':
      '<path d="M3 6h18"/>' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
      '<path d="M10 11v6"/><path d="M14 11v6"/>',
    // lucide:panel-right
    'panel-right':
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<path d="M15 3v18"/>',
    // panel-right(open):右侧分区填充,表示 inspector 已展开
    'panel-right-open':
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<path d="M15 3v18"/>' +
      '<rect x="15" y="3" width="6" height="18" rx="0" fill="currentColor" stroke="none"/>',
    // lucide:refresh-cw
    'refresh-cw':
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>' +
      '<path d="M21 3v5h-5"/>' +
      '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>' +
      '<path d="M8 16H3v5"/>',
    // lucide:chevron-down
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    // lucide:chevron-right
    'chevron-right': '<polyline points="9 6 15 12 9 18"/>',
    // lucide:ellipsis (more-horizontal) —— 三个点,用 stroke 描边小圆
    'more-horizontal':
      '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    // lucide:maximize-2 —— 两个对角箭头向外,表示放大/展开
    'maximize-2':
      '<polyline points="15 3 21 3 21 9"/>' +
      '<polyline points="9 21 3 21 3 15"/>' +
      '<line x1="21" y1="3" x2="14" y2="10"/>' +
      '<line x1="3" y1="21" x2="10" y2="14"/>',
    // lucide:minimize-2 —— 两个对角箭头向内,表示缩小/还原
    'minimize-2':
      '<polyline points="4 14 10 14 10 20"/>' +
      '<polyline points="20 10 14 10 14 4"/>' +
      '<line x1="14" y1="10" x2="21" y2="3"/>' +
      '<line x1="3" y1="21" x2="10" y2="14"/>',
  }

  export function pathOf(name: IconName): string {
    return PATHS[name]
  }
</script>

<script lang="ts">
  type Props = {
    name: IconName
    /** size in em (default 1em) or px number. */
    size?: number | string
    /** 线条粗细,默认 1.75。粗一点更适合小尺寸图标。 */
    stroke?: number
    /** 额外 class,方便外部加间距/位移。 */
    class?: string
    /** title (a11y) */
    title?: string
  }
  let { name, size = '1em', stroke = 1.75, class: klass = '', title }: Props = $props()

  let dim = $derived(typeof size === 'number' ? `${size}px` : size)
  let pathHtml = $derived(pathOf(name))
</script>

<svg
  class="icon {klass}"
  width={dim}
  height={dim}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={title ? undefined : true}
  role={title ? 'img' : undefined}
>
  {#if title}<title>{title}</title>{/if}
  {@html pathHtml}
</svg>

<style>
  .icon {
    display: inline-block;
    vertical-align: -0.15em; /* 视觉上跟文字基线对齐,跟 emoji 一致的微下沉 */
    flex-shrink: 0;
  }
</style>
