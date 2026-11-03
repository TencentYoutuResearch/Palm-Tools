/**
 * 重命名同步:tab 改名后要通知后端(`set_title`),后端才会广播 `meta { title }`,
 * 云同步/手机端据此更新会话名。弹窗重命名和侧边栏行内重命名必须共用这一条路径,
 * 否则只改了前端 store,手机端永远看不到新名字。
 */

/// 与 ipc.ts 的 EndpointId 同构;这里不 import ipc(依赖 Tauri),保证可在 node 下测试。
type EndpointLike = { kind: 'local' } | { kind: 'remote'; id: string } | null | undefined

/// 只有本地会话存在于后端 `ctx.sessions`,remote endpoint 的 tab 没有对应的 set_title 目标。
export function shouldSyncTitleToBackend(endpointId: EndpointLike): boolean {
  return !endpointId || endpointId.kind === 'local'
}

/// 应用一次重命名:先乐观更新前端,再(仅本地会话)同步后端。
/// 后端失败不回滚前端名字(用户已看到新名字),仅返回 false 供调用方记录日志。
export async function applyTabRename(
  id: number,
  endpointId: EndpointLike,
  title: string,
  deps: {
    renameTab: (id: number, title: string) => void
    setTitle: (id: number, title: string) => Promise<void>
  },
): Promise<boolean> {
  deps.renameTab(id, title)
  if (!shouldSyncTitleToBackend(endpointId)) return true
  try {
    await deps.setTitle(id, title)
    return true
  } catch (e) {
    console.error('set_title failed:', e)
    return false
  }
}
