import { useEffect, useState } from 'react'
import { discussionKey, discussionScope, sameDiscussionScope, requestDiscussion } from './discussion-model.js'

/** Read-only sidebar recovery. Each attempt owns its scope and cancellation;
 * no draft, pending creation or pending message storage is involved. */
export function useDiscussionSidebarDirectory(scope, version) {
  const key = discussionKey(scope)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState(null)
  useEffect(() => {
    const exact = discussionScope(scope), controller = new AbortController()
    let live = true
    const fail = () => { if (live) setState({ key, error: '讨论空间暂不可用，请检查后端版本与访问权限。', page: null }) }
    setState({ key, page: null, error: '' })
    // Bound browser connection-queue time as well as the Host's backend timeout.
    const timer = setTimeout(() => { fail(); controller.abort() }, 20000)
    requestDiscussion('surfaces', exact, undefined, { signal: controller.signal }).then(page => {
      if (!live || controller.signal.aborted) return
      if (!sameDiscussionScope(page?.scope, exact) || !Array.isArray(page?.items)
        || page.items.some(row => !sameDiscussionScope(row?.scope, exact))) throw Error('scope mismatch')
      setState({ key, page, error: '' })
    }).catch(() => { if (!controller.signal.aborted) fail() }).finally(() => clearTimeout(timer))
    return () => { live = false; clearTimeout(timer); controller.abort() }
  }, [key, version, attempt])
  const current = state?.key === key ? state : { page: null, error: '' }
  return { ...current, retry: () => setAttempt(value => value + 1) }
}
