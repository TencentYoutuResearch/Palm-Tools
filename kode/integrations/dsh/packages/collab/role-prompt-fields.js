import React from 'react'
import { PROMPT_MAX_BYTES, utf8Bytes, promptValue } from './role-prompt.js'
export * from './role-prompt.js'
const h = React.createElement

export const ROLE_PROMPT_NOTE = '角色指令随团队版本保存，运行时作为该角色的工作说明加载。固定的系统安全规则、权限与任务授权始终优先，指令不能放宽它们；也不会改变所用的 Agent 或模型。留空表示不设置。'

/** One instruction box with a UTF-8 byte counter; native textarea, no JSON. */
export function RolePromptField({ label, value, onChange, max = PROMPT_MAX_BYTES, disabled, readOnly, placeholder }) {
  const bytes = promptValue(value) === undefined ? 0 : utf8Bytes(value), over = bytes > max
  return h('label', { className: 'kode-role-prompt' }, h('span', null, label),
    h('textarea', { value: value ?? '', rows: 4, disabled, readOnly, placeholder: placeholder ?? '例如：先列出要改的文件和验证方式，再动手。', 'aria-invalid': over || undefined, onChange: event => onChange(event.target.value) }),
    h('small', { className: 'kode-role-prompt-count', 'data-over': over || undefined, 'aria-live': over ? 'polite' : undefined },
      over ? `${bytes} / ${max} 字节，超出上限，无法保存` : bytes ? `${bytes} / ${max} 字节` : '未设置'))
}

export const rolePromptStyles = `
.kode-role-prompt{display:grid;gap:6px;margin:12px 0}
.kode-role-prompt textarea{box-sizing:border-box;width:100%;min-height:88px;padding:8px 10px;font:inherit;color:inherit;resize:vertical;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.kode-role-prompt textarea:focus-visible{outline:2px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.kode-role-prompt textarea[aria-invalid=true]{border-color:var(--dsw-alias-state-danger,currentColor)}
.kode-role-prompt-count{justify-self:end;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kode-role-prompt-count[data-over]{color:var(--dsw-alias-state-danger,currentColor)}
`
