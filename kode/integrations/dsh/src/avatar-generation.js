/** dsh-only launch request; Kode desktop's own prompt and artwork remain unchanged. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { access, mkdir } from 'node:fs/promises'

export async function avatarGenerationPrompt(appearance, { avatarId, backgroundOnly = false } = {}) {
  const skill = fileURLToPath(new URL('../assets/skills/kode-generate-avatar/SKILL.md', import.meta.url))
  const splitter = join(skill, '../scripts/split_avatar_sheets.py')
  await access(skill); await access(splitter)
  const gallery = join(appearance.root, 'gallery')
  await mkdir(gallery, { recursive: true })
  if (backgroundOnly) {
    const reference = await appearance.imagePath(avatarId ?? '', 'idle')
    if (!reference) throw new Error('请先选择一个可用的自定义头像。')
    return { prompt: `请读取并遵循 dsh 内置头像技能 \`${skill}\`，仅为已有头像 ${JSON.stringify(avatarId)} 补生成配套的会话背景（background only）。保留所有已有动画帧；人物参考图为 ${JSON.stringify(reference)}，头像目录为 ${JSON.stringify(join(appearance.root, avatarId))}。先询问我希望的场景，再使用与头像一致的画风生成独立横向背景，建议 1920×1080，中央留出安静的对话阅读区域，不含文字或 UI。保存为该目录中的 background.png（或与实际格式匹配的 background.jpg / background.webp），完成后目视检查。所有提问和说明使用简体中文。` }
  }
  return { prompt: `请调用 Kode 内置技能 \`$kode-generate-avatar\` 为我生成自定义动态头像和配套的 dsh 会话背景。先完整读取 ${JSON.stringify(skill)} 并严格执行，分割脚本为 ${JSON.stringify(splitter)}；最终头像必须写入 ${JSON.stringify(gallery)} 下。第一步先询问我想生成的人物名称或人物形象/参考图；人物确认后，再询问画风、avatar-id 和背景场景。使用技能规定的 3×3 状态面板、每面板 2×2 帧版式，生成并拆分 running/01..06、error、idle、awaiting 共 36 帧并逐态目视检查。另生成一张与该人物及画风一致的独立横向会话背景，建议 1920×1080，画面中心安静、适合叠加对话文字，不含文字或 UI，保存为对应头像目录中的 background.png（或与实际格式匹配的 background.jpg / background.webp）。背景不得放入动画帧中。所有提问、进度和报告使用简体中文。生成完成后告知我刷新 dsh 头像弹窗并选择新头像即可同时应用背景。` }
}
