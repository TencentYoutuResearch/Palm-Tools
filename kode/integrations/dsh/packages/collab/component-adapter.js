import React from 'react'
/** Own one wrapper, never traverse or rewrite another plugin's component chain. */
export function adaptSlotComponent(entry, Enhanced) {
  const Original = entry.component
  if (typeof Original !== 'function' || typeof Enhanced !== 'function') throw Error('Function slot components required')
  const listeners = new Set()
  let active = true
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const snapshot = () => active
  function Adapted(props) {
    const enabled = React.useSyncExternalStore(subscribe, snapshot, snapshot)
    return enabled ? React.createElement(Enhanced, { ...props, native: Original }) : React.createElement(Original, props)
  }
  entry.component = Adapted
  return {
    component: Adapted,
    deactivate() {
      if (!active) return
      active = false
      Enhanced = null // Release the disposed plugin closure even when a later wrapper retains Adapted.
      // A later plugin may retain Adapted. Its mounted copy must also stop using Enhanced.
      let failure
      for (const listener of [...listeners]) { try { listener() } catch (error) { failure ??= error } }
      if (entry.component === Adapted) entry.component = Original
      if (failure) throw failure
    },
  }
}
