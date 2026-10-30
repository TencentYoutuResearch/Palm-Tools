/// 按项目记住 BackendChooser 的 "Bypass permissions" 勾选。
///
/// 以项目路径(规范化 cwd)为维度,与 backend / endpoint 无关:某路径勾选过 bypass 后,
/// 在该路径新建任意 backend 的会话都默认勾选。只存勾选过的路径;取消勾选后启动会把
/// 该路径移出。Session history 里的 Resume 也走同一个 toggle,所以恢复会沿用该路径的 permission。

const STORAGE_KEY = 'kode.chooser.bypassProjects'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function projectKey(cwd: string): string | null {
  const dir = cwd.trim().replace(/\/+$/, '')
  return dir || null
}

function load(storage: Storage): Record<string, true> {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function rememberedBypass(
  cwd: string,
  storage: Storage | null = defaultStorage(),
): boolean {
  const key = projectKey(cwd)
  return Boolean(key && storage && load(storage)[key] === true)
}

export function rememberBypass(
  cwd: string,
  bypass: boolean,
  storage: Storage | null = defaultStorage(),
): void {
  const key = projectKey(cwd)
  if (!key || !storage) return
  const projects = load(storage)
  if (bypass) projects[key] = true
  else delete projects[key]
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(projects))
  } catch {}
}
