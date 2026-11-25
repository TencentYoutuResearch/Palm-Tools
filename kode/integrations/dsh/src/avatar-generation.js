/** dsh-only launch request; Kode desktop's own prompt and artwork remain unchanged. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { access, mkdir } from 'node:fs/promises'

export async function avatarGenerationPrompt(appearance, { avatarId, backgroundOnly = false, botName = '', botPersona = '' } = {}) {
  const skill = fileURLToPath(new URL('../assets/skills/kode-generate-avatar/SKILL.md', import.meta.url))
  const splitter = join(skill, '../scripts/split_avatar_sheets.py')
  await access(skill); await access(splitter)
  const gallery = join(appearance.root, 'gallery')
  await mkdir(gallery, { recursive: true })
  const botContext = botName
    ? `这是为伙伴「${botName}」定制的形象${botPersona ? `（角色设定：${botPersona.slice(0, 240)}）` : ''}。`
    : ''
  const scene = '先确认背景场景和配色风格，以及使用静态图还是动态背景。保持与头像一致的画风，同时生成两份配套背景：（1）会话背景 background.png（或 jpg/webp，建议 1920×1080，中央留出安静的阅读区域，不含文字或 UI）；（2）Discord 风格的侧边栏/名片横幅背景 banner.png（建议 1200×360 宽幅，左侧保持深色/柔和低对比度确保伙伴头像与名字清晰可读，右侧铺展与人物和画风呼应的主题光效、场景纹理或装饰元素，不含文字或 UI）。如需动态会话背景，按技能额外生成静音、可循环的 H.264 background.mp4，并保留静态封面。'
  if (backgroundOnly) {
    const reference = await appearance.imagePath(avatarId ?? '', 'idle')
    if (!reference) throw new Error('请先选择一个可用的自定义头像。')
    return { prompt: `${botContext}请读取并遵循 dsh 内置头像技能 \`${skill}\`，仅为已有头像 ${JSON.stringify(avatarId)} 补生成配套的会话背景和 Discord 风格侧边栏横幅背景（background only）。保留所有已有动画帧；人物参考图为 ${JSON.stringify(reference)}，头像目录为 ${JSON.stringify(join(appearance.root, avatarId))}。${scene}所有提问和说明使用简体中文。` }
  }
  return { prompt: `${botContext}请调用 Kode 内置技能 \`$kode-generate-avatar\` 为我生成自定义动态头像，以及配套的 dsh 会话背景和 Discord 风格侧边栏横幅背景。先完整读取 ${JSON.stringify(skill)} 并严格执行，分割脚本为 ${JSON.stringify(splitter)}；最终头像必须写入 ${JSON.stringify(gallery)} 下。第一步先询问我想生成的人物名称或人物形象/参考图；人物确认后，再询问画风、背景氛围和 avatar-id。使用技能规定的 3×3 状态面板、每面板 2×2 帧版式，生成并拆分 running/01..06、error、idle、awaiting 共 36 帧并逐态目视检查。为同一头像目录生成独立会话背景（background.png）与 Discord 风格侧边栏横幅背景（banner.png）。${scene}背景不得放入动画帧中。所有提问、进度和报告使用简体中文。生成完成后告知我刷新 dsh 头像弹窗或伙伴编辑页并选择新头像与背景风格；如生成了动态视频，可在「头像与背景」中选择「动态」。` }
}
