# GitHub Release 签名与 Beta 更新

## 三类签名

- **Apple Developer ID Application 签名与公证**：macOS 外部分发身份。`Apple Development` 开发证书不是 Developer ID 分发证书；ad-hoc 也不等于 Apple 认证。
- **Windows Authenticode 签名**：Windows 外部分发身份。必须同时签 `kode-gui.exe`、sidecar 和 NSIS 安装包；未签名的开发包不应作为正式安装包分发。
- **Tauri updater 签名**：应用下载 `.app.tar.gz` 时验证来源。与 Apple 证书独立，必须使用匹配 `apps/gui/src-tauri/tauri.conf.json` 中 `plugins.updater.pubkey` 的 minisign 私钥。

DMG 用于首次手动安装；应用内更新使用 `.app.tar.gz`、`.sig` 和 `latest.json`，只有 DMG 的 Release 不能提供应用内更新。

Tauri updater 签名与 Windows Authenticode 也是两套独立机制。updater 签名只保护应用内更新，不能让 SmartScreen、Defender 或其他安全产品把安装包识别为已知发布者。

## GitHub 配置

在 `TencentYoutuResearch/Palm-Tools` → Settings → Secrets and variables → Actions 配置。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret，应用内更新必需 | `TAURI_SIGNING_PRIVATE_KEY` | 原有 Tauri updater 私钥文件的完整内容，不是文件路径，也不是 Apple 证书 |
| Secret，加密私钥时需要 | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 私钥密码；未加密则不设置 |
| Secret，Apple 分发签名需要 | `APPLE_DEVELOPER_ID_P12_BASE64` | 包含 Developer ID Application 证书及对应私钥的 `.p12` 的 Base64 内容 |
| Secret，Apple 分发签名需要 | `APPLE_DEVELOPER_ID_P12_PASSWORD` | 导出 `.p12` 时设置的密码 |
| Variable，Apple 签名身份 | `APPLE_SIGNING_IDENTITY` | 钥匙串中完整的 `Developer ID Application: … (TEAMID)` 名称；覆盖仓库配置中的原有身份 |
| Secret，公证需要 | `APPLE_ID` | Apple 开发者账号邮箱 |
| Secret，公证需要 | `APPLE_PASSWORD` | Apple 账号创建的 App 专用密码，不是登录密码 |
| Secret，公证需要 | `APPLE_TEAM_ID` | 该证书所属团队 ID |

Apple 公证的三个 Secret 必须一起配置。证书从钥匙串「我的证书」导出，须包含对应私钥；Base64 可通过 `openssl base64 -A -in /path/to/certificate.p12 -out /path/to/certificate-base64.txt` 生成。不要将证书、Base64、密码或 updater 私钥提交到 Git。

仓库工作流使用 `apple-actions/import-codesign-certs` 导入证书，因此这里的 Secret 名称与 Tauri 文档示例的 `APPLE_CERTIFICATE` 不同。未配置 Developer ID 时 CI 仍可生成 ad-hoc 测试包及独立签名的 updater 包，但不应标记为已通过 Apple 分发签名和公证。

### 现有 updater 密钥

先从安全备份恢复原来的 `.tauri/kode-updater.key`，确认它对应已固化的公钥，再填写 Secret。密钥丢失后不能仅换一把私钥继续给旧安装包更新：旧应用不会接受新密钥签名。确需换钥时必须同步公钥并安排用户手动安装过渡版本。

当前本机已生成新的 `.tauri/kode-updater.key` 和 `.pub`，应用配置已同步新公钥。父仓库 `.gitignore` 的 `kode/.tauri/` 已忽略整个密钥目录，公钥通过 Tauri 配置入库即可，无需提交密钥文件。使用旧公钥的安装包需要手动安装一次新版本。

生成本地密钥不会自动配置 GitHub。可以在设置页面填写，或从 kode 目录运行 `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo TencentYoutuResearch/Palm-Tools < .tauri/kode-updater.key`；有密码时再运行 `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo TencentYoutuResearch/Palm-Tools` 并按提示输入。

## 发布

1. 合并并测试包含更新逻辑的代码，配置上述 Secret。工作流缺少 updater 私钥会直接报错。
2. 使用递增的 SemVer 标签发布，例如 `v0.2.3-beta.1`。带 `-` 的标签自动标记为 GitHub prerelease；`v0.2.3` 则为正式版。不要覆盖已经发布的标签或用旧版代码重新打包。
3. Release 应包含两个架构的 `kode_<version>_<arch>.app.tar.gz` 及对应 `.sig`，以及覆盖 `darwin-aarch64` / `darwin-x86_64` 的 `latest.json`。版本由标签统一写入 Cargo、GUI package 和 Tauri 配置。
   CI 会校验完整 `.app` 签名（包括 ad-hoc），并通过 `deploy/verify-updater.py` 使用应用内公钥验证更新包签名；密钥不匹配时禁止发布。
4. 在装有同一公钥、版本更低的测试应用上开启 Beta、检查更新、安装并手动重启，核实显示的版本、启动和会话恢复。Apple 正式发布还应验证完整签名和公证结果。

当前 `0.2.2-dev` 的 SemVer 排序高于 `0.2.2-alpha.2`，正常更新需发布更高版本，例如 `0.2.3-beta.1`。测试同版安装或降级时，可在设置 → 软件更新开启「调试：忽略本地版本号」：仅跳过本地版本比较，仍选择当前通道最高版本的非草稿 Release，并校验平台资产、manifest 与 tag 一致性以及更新包签名。开关默认关闭，仅本次运行有效，重启后关闭；测试预发布版还需开启 Beta。开关变化立即重新检查，安装期间不可切换。

Windows 正式发布应使用稳定的组织 Authenticode 证书，以 SHA-256 摘要和 RFC 3161 时间戳签名，并保持 Publisher、安装目录和文件名稳定。更换发布者或签发方式会丢失已有 SmartScreen/Defender 信誉。疑似误报应同时向 Microsoft Security Intelligence 提交样包复核，而不是通过混淆、关闭安全日志或规避扫描解决。

通过 `./run.sh app` 构建的应用同样可以从 GitHub 更新：构建时的公钥必须匹配 Release 签名，且应用所在目录可写。建议将完整 `.app` 放到 Applications 后运行；不要从只读 DMG 内测试安装。运行时不需要私钥，私钥仅用于构建签名更新产物。下载、安装仍需用户点击，调试开关不会自动开始安装。

## 用户行为

- 设置 → 软件更新 → 开启 Beta 体验，默认关闭，偏好保存在当前桌面用户环境。
- 关闭时仅选择正式版；开启时选择正式版和预发布版中版本号最高的已发布 Release。草稿和非法版本标签不参与；不会自动降级。
- 启动、每 4 小时、网络恢复时自动检查，也支持手动检查。后台失败不弹窗，设置中显示错误并可重试。
- 较新的 Release 缺少当前架构的签名更新资产时显示尚未提供更新包，不将其误报为已是最新版，也不静默退回旧包。
- 用户主动安装后才下载并校验签名；安装结束不自动重启，可继续当前工作并稍后重启。
- 历史上没有集成 updater 的应用必须先手动安装带更新功能的版本。

## 本地检查

CI 通过 `deploy/build-macos-ci.sh` 开启 Tauri 详细日志，显示 `bundle_dmg.sh` 内部的磁盘镜像错误。仅当该脚本失败时重试一次，复用编译缓存；编译、签名错误或第二次失败仍阻断发布。未配置 Apple 公证的 warning 本身不是 DMG 失败原因。若重试后仍失败，应根据详细日志定位，不能仅凭顶层 `failed to run bundle_dmg.sh` 判定原因。

本地交互终端未设置密码环境变量时，脚本会在编译前隐藏输入地询问私钥密码（无密码直接回车）。非交互构建应预先设置密码环境变量。签名预检失败会立即停止，不再等待完整编译后才发现密码错误。

`./run.sh app` 默认生成 `.app`、`.dmg` 和签名更新包。未设置 `TAURI_SIGNING_PRIVATE_KEY` 时会自动加载 `.tauri/kode-updater.key`，已有环境变量（包括 CI Secret）优先；若私钥加密，另设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。缺少密钥会在编译前报错。没有 Developer ID 时使用 ad-hoc 签名，公证提示属于预期；可显式设置 `KODE_FORCE_DMG=0` 跳过 DMG。

```bash
security find-identity -v -p codesigning
codesign -dv --verbose=4 target/release/bundle/macos/kode.app
codesign --verify --deep --strict target/release/bundle/macos/kode.app
spctl --assess --type execute --verbose=4 target/release/bundle/macos/kode.app
# 替换为实际 DMG 路径：
codesign -dv --verbose=4 /path/to/kode.dmg
xcrun stapler validate /path/to/kode.dmg
```

参考：[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Tauri Updater](https://v2.tauri.app/plugin/updater/)、[GitHub Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。
