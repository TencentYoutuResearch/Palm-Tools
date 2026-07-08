/**
 * longpress_gate —— 让 svelte-dnd-action 的拖拽只在「长按」后触发。
 *
 * 为什么需要这个 action:
 *   svelte-dnd-action@0.9.70 鼠标按下即进入 drag-ready 状态,只要 pointer 移动
 *   超过 3px(MIN_MOVEMENT_BEFORE_DRAG_START_PX)就触发拖拽。点击 tab 想选中时
 *   手稍微一抖就变成拖拽,体验差。它自带的 `delayTouchStart` 只对触屏生效,
 *   鼠标/触控板没有内置长按选项。
 *
 * 原理:
 *   在 capture 阶段拦截 `mousedown`(触屏交给 dndzone 自带的 delayTouchStart,
 *   不处理),阻止事件传到 dndzone。启动一个长按计时器:
 *     - 到时 → 用合成 MouseEvent 重新派发一次 mousedown,此时 dndzone 才接管;
 *       tab 切到 .longpress-armed 态(cursor: grabbing + 轻微抬起动画)
 *     - 期间 pointer 移动 > MAX_MOVE_BEFORE_GATE_RELEASE_PX → 视为点击/滚动,
 *       取消闸门;当前 mousedown 已被吞,但 click 是独立事件,会正常派发,
 *       tab 选中不受影响
 *     - 期间 mouseup → 取消(点击放行)
 *   拖拽开始后,继续监听 mouseup —— 用户松手时清掉 .longpress-armed。
 *
 * 仅作用于鼠标左键(button=0);右键/中键不拦截,保留原生 contextmenu 等。
 *
 * 用法:
 *   <nav use:dndzone={...} use:longpressGate on:consider on:finalize>
 *   dndzone 必须配置 `delayTouchStart` 给触屏,鼠标走本 action。
 */

export const TAB_DRAG_LONG_PRESS_MS = 600
/**
 * 长按等待期间允许的微小抖动;超过即视为「用户在移动鼠标/滚动,不是长按」→ 放弃闸门。
 *
 * **必须严格小于 svelte-dnd-action 的 MIN_MOVEMENT_BEFORE_DRAG_START_PX(3px,dist
 * 内硬编码不可配)**。原因:600ms 到时后我们 re-dispatch 合成 mousedown 给 dndzone,
 * dndzone 以原始按下点 startX/startY 为拖拽起点。若本容差 ≥3px,到时那一刻指针可能
 * 已离起点 3~6px,dndzone 接管后**瞬间**就判定为拖拽 —— 用户只是按了一下没打算拖也被
 * 拖出来。取 2px(<3px)确保「按住基本不动满 600ms」才进入拖拽,否则一律当点击放行。
 */
const MAX_MOVE_BEFORE_GATE_RELEASE_PX = 2

export function longpressGate(node: HTMLElement) {
  let timer: number | undefined
  /** 长按计时阶段(还没到时) */
  let arming = false
  /** 长按已到时,dndzone 已接管,等 mouseup 收尾 */
  let armed = false
  let armedTab: HTMLElement | null = null
  let startX = 0
  let startY = 0
  /** 正在 re-dispatch 合成 mousedown —— 此时 capture handler 要放行,避免递归拦截 */
  let redispatching = false

  function clearArmedTabClasses() {
    if (armedTab) {
      armedTab.classList.remove('longpress-arming')
      armedTab.classList.remove('longpress-armed')
    }
  }

  /** 长按等待阶段被取消(移动过大 / 提前抬起) */
  function cancelArming() {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    arming = false
    clearArmedTabClasses()
    armedTab = null
    window.removeEventListener('mousemove', onWaitingMouseMove, true)
    window.removeEventListener('mouseup', onArmingMouseUp, true)
  }

  /** 拖拽已开始(dndzone 接管)后,松手时清掉 .longpress-armed */
  function onArmedMouseUp() {
    armed = false
    clearArmedTabClasses()
    armedTab = null
    window.removeEventListener('mouseup', onArmedMouseUp, true)
  }

  function onWaitingMouseMove(e: MouseEvent) {
    if (!arming) return
    if (Math.abs(e.clientX - startX) > MAX_MOVE_BEFORE_GATE_RELEASE_PX || Math.abs(e.clientY - startY) > MAX_MOVE_BEFORE_GATE_RELEASE_PX) {
      // 用户在动鼠标,不是长按 → 放弃闸门,让接下来的点击/选中正常发生
      cancelArming()
    }
  }

  function onArmingMouseUp(_e: MouseEvent) {
    // 长按时间未到就抬起 → 当作点击,放行
    cancelArming()
  }

  function onDownCapture(e: MouseEvent) {
    // re-dispatch 的合成 mousedown 直接放行给 dndzone
    if (redispatching) return
    // 仅拦鼠标左键;右键/中键交给浏览器原生行为(contextmenu 等)
    if (e.button !== 0) return
    // 嵌套 input/textarea/contenteditable 不拦,让 input 正常聚焦
    const t = e.target as Element | null
    if (t && t.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) return

    // tab 内的交互控件(⋯ 菜单按钮 / 菜单项 / 关闭按钮 / 可重命名标题)不拦:
    // 这些靠原生 click 工作,若进入长按闸门,按超过长按阈值会被 re-dispatch 成
    // dndzone 拖拽,onDndConsider 把 menuOpenId 清掉 —— 菜单永远开不起来。
    if (t && t.closest('.more-btn, .tab-menu, .close-btn, .tab-title-input')) return

    // 找到被按的 .tab(dndzone 的 draggableEl) —— 合成事件必须 dispatch 到它,
    // 不能 dispatch 到子元素,否则 dndzone 的 handleMouseDown 里
    // e.target !== e.currentTarget 分支会走错。
    const tabEl = (t && t.closest<HTMLElement>('.tab')) || null
    if (!tabEl) return

    // 阻断 dndzone 的 mousedown 监听(它在 bubble 阶段绑在 draggableEl 上)。
    // 只 stopImmediatePropagation,不 preventDefault —— preventDefault 会阻止
    // 浏览器派发后续 click,导致 tab 选中失效。
    e.stopImmediatePropagation()

    armedTab = tabEl
    arming = true
    startX = e.clientX
    startY = e.clientY
    // 立即给视觉反馈:tab 进入「长按中」态(轻微缩起)
    armedTab.classList.add('longpress-arming')

    timer = window.setTimeout(() => {
      // 长按到时 → 重新派发一个合成 mousedown,让 dndzone 接管当前这次按压
      arming = false
      window.removeEventListener('mousemove', onWaitingMouseMove, true)
      window.removeEventListener('mouseup', onArmingMouseUp, true)
      // 切到「可拖拽」态:cursor 变 grabbing,轻微抬起
      armedTab?.classList.remove('longpress-arming')
      armedTab?.classList.add('longpress-armed')
      armed = true

      const Ctor = globalThis.MouseEvent as unknown as {
        new (type: string, init: MouseEventInit): MouseEvent
      }
      const synth: MouseEvent = new Ctor('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: startX,
        clientY: startY,
      })
      // dispatch 到 .tab 本身 —— dndzone 的 handleMouseDown 在此元素上监听,
      // e.target === e.currentTarget,跳过 input/嵌套元素分支
      redispatching = true
      try {
        armedTab?.dispatchEvent(synth)
      } finally {
        redispatching = false
      }
      // 继续监听 mouseup —— 拖拽结束时清掉 .longpress-armed
      window.addEventListener('mouseup', onArmedMouseUp, true)
    }, TAB_DRAG_LONG_PRESS_MS)

    window.addEventListener('mousemove', onWaitingMouseMove, true)
    window.addEventListener('mouseup', onArmingMouseUp, true)
  }

  // capture 阶段优先于 dndzone 的 bubble 阶段监听
  node.addEventListener('mousedown', onDownCapture, true)

  return {
    destroy() {
      if (arming) cancelArming()
      if (armed) onArmedMouseUp()
      node.removeEventListener('mousedown', onDownCapture, true)
    },
  }
}
