import React from 'react'
const label = '创建团队'
function relabel(node) {
  if (typeof node === 'string') return label
  if (!React.isValidElement(node) || node.props.children === undefined) return node
  return React.cloneElement(node, {}, React.Children.map(node.props.children, relabel))
}
/** Reuse the native sidebar seat, geometry and icon; never claim its session shortcut. */
export function teamPrimaryAction(native, openBuilder) {
  const button = native?.props?.children
  if (!React.isValidElement(native) || !React.isValidElement(button) || button.type !== 'button') return null
  const mask = React.Children.toArray(button.props.children)[0]
  return React.cloneElement(native, { label, shortcutKeys: undefined }, React.cloneElement(button, {
    'aria-label': label, 'aria-keyshortcuts': undefined, onClick: openBuilder,
  }, relabel(mask)))
}
