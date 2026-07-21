---
schema_version: 1
id: specops/engine-roadmap
kind: spec
title: SpecOps — spec-driven execution console built into kode
status: active
verifies:
  - specops
paths:
  - apps/specops
  - .specops
---

> **Harness 完成口径**:Task DAG 排序和隔离 Run 只是基础,不等于 Harness 调度器完成。完整口径见 `specops-harness-core.md`:必须具备持久化事件、逐 task 调度、类型化 Artifact、可执行 Gate、精确 Evidence 和 Drift 恢复闭环。

# SpecOps — kode 内置的 spec 驱动执行控制台(立项草稿)

> **状态**:立项设计草稿 / 本 feature 的 ROADMAP,2026-06-20(第四轮工程化评审:补齐 Run 隔离、安全启动契约、gate 语义与执行计划)。
> **物理位置**:`kode/apps/specops/`(与 `apps/gui` / `apps/mobile` 平级的 kode 子应用)。
>
> **双重身份(关键,别再纠结二选一)**:
> - **对 kode 而言,SpecOps 是 kode 的一个 feature**:由 kode `⌘S` 唤起,console 嵌进 kode gui 的 webview 面板,执行用 kode 的 tab(codebuddy/claude session)当 agent 后端,kode gui 原生观察这些 session。**这套集成 = kode 的能力**。
> - **对代码而言,SpecOps 引擎工程无关**:引擎是个 Node/TS 程序,起 `serve` 后通过 Phase 9 协议跟"某个 kode"对话,**它不知道自己嵌在 kode 里**,理论上也能 `npx specops` 独立跑在任意工程。
> - 这两件事不矛盾:**引擎的工程无关性** 让它可被复用;**集成的归属性** 让它是 kode 的 feature。本文档同时服务这两个目标。
>
> **⚠️ 分层红线(让 feature 集成与引擎独立并存)**:
> 1. **引擎不反向依赖 kode**:specops 引擎不 import kode 任何 crate;它通过 Phase 9 协议(REST+WS)连 kode,与 Flutter app / Go server 是**平级协议客户端**。这样引擎保持工程无关,集成全在 kode 侧(spawn 引擎 + 嵌 webview + 当执行后端)。
> 2. **集成层归 kode**:`⌘S` 唤起、webview 面板、spawn `specops serve`、Phase 9 派 tab —— 这些是 kode gui(`apps/gui`)的代码,是 kode 的 feature 实现。
> 3. **引擎不硬编码 kode**:引擎里不出现"只为 kode 服务"的假设(如硬编码 codebuddy 路径);它只认 Phase 9 协议端点。kode 恰好是第一个、也是默认的宿主。
>
> **来源**:kode 仓 `docs/new-feat.md`(原始 SpecOps 构想)经三轮评审后的**重定位版本**。原文档把 SpecOps 设计成"塞进某个 web 业务工程的治理平台",与 kode 定位错位;本文档把它重做成 **kode 内置的 spec 驱动执行控制台**(引擎工程无关,集成是 kode feature)。

---

## 0. 一句话定位

> SpecOps 是 **kode 内置的 spec 驱动执行控制台**:`⌘S` 在 kode 里唤起 → 选工程路径 → 检测/创建 `.specops/` → kode 起 `specops serve` 并把 console 嵌进 gui → 在 console 里加/查/审 spec → 触发执行时 kode 建 tab 跑 agent → 完成后对照 spec verify(MVP 半自动,见 §6.8)回流 console。
> **引擎**(Node/TS)负责"算 + 控台"(scan / gate / drift + web console);**kode** 负责"唤起 + 嵌入 + 执行 + 观察"。Git 是事实源。
> spec/change/archive 内核**抽取自 OpenSpec 的核心模型,用 TS 重写**,不依赖 `openspec` 包(见 §8.7)。
> 编排骨架(控台↔本地执行器↔结果回流)**借鉴 multica**,但用 specops 的 spec/gate 补上 multica 缺的**验收闸门**(见 §6.7)。

与原 `new-feat.md` 的最大区别:

| 维度 | new-feat.md(旧) | 本文档(新) |
|---|---|---|
| 形态 | 某个 web 业务工程内的治理平台 | **引擎工程无关 + 集成是 kode feature**,任意工程可 `specops init` |
| 入口 | "HTML Console 是主工作台" | **CLI 是主入口**;web console 是可选前端,但**保留带 agent 对话的审阅流程**作为文档密集型工作的主战场 |
| 与宿主关系 | 强耦合(假设宿主是 Next/React monorepo) | **零代码依赖**,语言无关 |
| 与 OpenSpec | 边界模糊 | **抽取核心三件用 TS 重写**,不 fork、不 wrap、不依赖 |
| 范围 | 5 大 plugin + Spec Graph + 全套 gate 一次到位 | MVP 做 7 件事(MVP-1~7,含审阅 console + 半自动执行闭环 + kode 集成),先在 kode dogfood |

---

## 1. 为什么"引擎工程无关 + 集成是 kode feature"是对的

(演进史已沉淀进 kode-memory,见 fact `01KVD9SDZ…`(最终定位,supersede 了早期"定位错位"判断)/ `01KVCSNGH…`(三条适配路线);本节是第三轮重定位后的最终结论。)

`new-feat.md` 描述的系统假设宿主是**带 UI 页面 / REST API / DB migration / PR gate 的 web 业务 monorepo**(`src/auth`、`packages/payment`、`apps/spec-console`,技术栈 Next/React + Node/FastAPI + Docusaurus + GitHub Actions)。

### 1.1 引擎为什么不能"长在某个业务工程身上"
任何业务工程都不该把治理逻辑长在自己代码里——否则:
1. 治理逻辑跟业务代码耦合,升级一处要改 N 个工程。
2. 换一个工程(Rust / Go / Flutter)就得重写一遍,因为它假设了 web 技术栈。

**所以引擎(scan/gate/drift/console)保持工程无关**:它只持有自己的逻辑,目标工程只持有 `specops.toml` + `.specops/` 配置数据。

### 1.2 但"集成进 kode"恰恰应该是 kode 的 feature
引擎工程无关,**不等于** kode 不能把它做成自己的 feature。两件事是不同层次:
- **引擎层**(工程无关):一个 Node/TS 程序,起 `serve` + 跑 gate,通过 Phase 9 协议跟"某个 kode"对话。
- **集成层**(kode 的 feature):`⌘S` 唤起、嵌 webview、spawn 引擎、用 kode tab 当执行后端、gui 观察 session —— 这套**用 kode 的能力把引擎包成一个顺手的产品**,本身就是 kode 该有的 feature。

类比:**Git 是工程无关的工具,但 VSCode 的"源代码管理"面板是 VSCode 的 feature**。SpecOps 引擎之于 kode,正是 Git 之于 VSCode。

### 1.3 这样同时拿到两个好处
- 引擎独立 → 不被 kode 绑死,将来能 `npx specops` 跑在别处(虽然 MVP 只服务 kode 宿主)。
- 集成归 kode → 用户体验上"specops 就是 kode 的一个功能",`⌘S` 一下就有,不用关心底下是个 Node 进程。
- 避开了 new-feat.md 的原始错误(把整套 web 治理平台塞进业务工程):这里塞进 kode 的只是**集成层**(Tauri webview + Phase 9 调用),引擎仍在 `apps/specops/` 独立构建,不撞 kode 的 `<15MB` Rust 主体。

---

## 2. 整体形态:引擎 + 可选 web console(看 + 审阅 + 改),分层

原 `new-feat.md` §2.4 的核心洞见是对的——**HTML / AI markdown 都应是生成物,Git/spec 才是事实源**。但它把 HTML Console 当成主入口是错的。正确的分层:

```
                    Git(canonical source)
                  spec 文件 / 配置 / 链关系
                          │
          ┌───────────────┴────────────────┐
          ▼                                 ▼
  ┌───────────────┐                 ┌──────────────────────┐
  │  specops CLI   │  产出状态 JSON   │     specops serve      │
  │  (引擎,无头)   │ ───────────────▶│   (本地 web console)    │
  │  scan/gate/    │   .specops/      │  看 + 审阅(与 agent     │
  │  drift/loop    │   state/*.json   │  对话完善文档)→ 写回    │
  └───────┬───────┘                 └───────┬──────────────┘
          │                                 │
          ▼                                 ▼
       进 CI / git hook                   开发机本地浏览器
       无 node 也能在容器跑                 预览 + 审阅对话 + 编辑
```

### 2.1 CLI 引擎(主入口,负责"算")

- `specops init` — 接入一个工程,生成 `specops.toml` + `.specops/` 骨架
- `specops scan` — 扫工程产出当前状态(spec 清单 / 绑定关系 / 覆盖矩阵),写 `.specops/state/*.json`
- `specops gate` — 跑门禁,返回 pass/fail + 原因(进 CI 的就是这条)
- `specops drift` — 检测 spec / 代码 / 测试 / 文档漂移
- `specops loop` — (后期)驱动 agent 在 spec 约束下迭代(并入 kode Phase 8 的思路,见 §6)

引擎**无头可跑**:进 CI、进 git pre-push hook,只要开发/CI 机有 node。**不依赖 web**。

### 2.2 web console(可选前端,负责"看 + 审阅 + 改")

`specops serve` 起本地 server(默认 `127.0.0.1:<随机端口>`),读 CLI 产出的 `state/*.json` + spec 文件。它**不只是只读预览,而是一个带审阅能力的 HTML console**,核心是把 spec/change 文档的「审阅 → 与 agent 对话完善 → 写回」这条流程搬到浏览器里。

**三种能力,逐层递进:**

1. **看(只读视图)**
   - dashboard(active changes / 覆盖率 / drift / 过期项)
   - spec detail(对应 §13.3)
   - 覆盖矩阵(对应 §9.5)
   - drift 列表

2. **审阅(核心,必须有)**——这是 web console 存在的主要理由,不是可选装饰。
   - 任一 spec / change 文档都可发起**审阅**。审阅 ≠ 简单批注,而是**与 agent 对话来完善这份文档**:
     - 用户在文档旁开对话框,对 agent 提出修改诉求(「这条不变量没覆盖 X 场景」「这个 change 的 scope 应该收窄」)。
     - agent 读当前 spec 上下文 + 用户意见,**提出文档修订建议(diff 形式)**。
     - 用户审阅 diff → 接受 / 继续追问 / 拒绝。多轮往返直到文档完善。
     - 接受后,修订**写回 spec 文件**(Git 仍是事实源)。
   - 这条「提交审阅 = 跟 agent 对话完善文档」的流程是**第一类公民**,与 CLI 的 scan/gate 并列,而非 web 的边角功能。
   - 审阅产生的 diff 走 Git,审阅对话本身可留痕(供回溯「这条 spec 为什么这么写」)。

3. **改(直接编辑)**——不想跟 agent 对话时,也允许在 web 里手工编辑 spec → 写回文件,作为审阅流程的轻量兜底。

**HTML 是视图,不是真相**:任何时候删掉 `.specops/state/` 和 web,`specops scan` 能从 spec 文件 + 代码重建——跟 kode-memory "SQLite 是可重建索引,facts/ 是事实源"同构。审阅写回的也是 spec 文件本身,console 只是编辑/对话的载体。

**关键**:web console 不是 *启动* 工程的必须入口(kode 这种宿主可以只用 CLI 跑 gate)。但对「写 spec / 审 change」这类**文档密集型工作**,带 agent 对话的审阅 console 才是它的主战场——CLI 算门禁,console 完善文档,两者职责互补。

> **agent 从哪来**:审阅对话需要一个 agent 后端(读 spec 上下文、产出文档 diff)。MVP 阶段倾向**复用宿主已有的 agent**(kode 宿主下即 codebuddy/claude,走 jsonl),而非 specops 自带模型。这与 §6 执行闭环的 agent 后端共享同一套「宿主提供 agent,specops 只编排对话与 diff」的思路,详见 §6 与 §7.4。

---

## 3. 技术选型:Node/TypeScript 引擎 + web 一体

| 维度 | 决策 | 理由 |
|---|---|---|
| 引擎语言 | **Node / TypeScript** | 引擎 + web 同语言,动态预览/可视化编辑生态最丰富(Vite / 任意前端框架),实时预览阻力最小。与 `new-feat.md` §21.2 产品化技术栈一致 |
| web | 引擎内嵌 server(express/fastify/hono)+ 前端 SPA | `serve` 起本地站,前端读引擎 API |
| 分发 | 开发预览:`pnpm` / `npx`;kode 正式包:编译后的 sidecar | 独立 CLI 降低接入摩擦;kode 内置功能必须开箱即用,不能要求最终用户另装 Node |

### 3.1 装进非 node 工程(如 kode)的缓解

这是 Node 选型唯一的代价,必须正面处理:

- **不要求宿主工程用 node**——只要求**开发机/CI 机有 node**(跟用 `eslint`/`prettier` 一个道理,工具链需求 ≠ 工程语言)。
- scanner **通过子进程调各语言原生工具**:Rust 工程调 `cargo`、Go 工程调 `go`、前端调 `pnpm`。引擎本身**语言无关**,只编排。
- 开发期允许依赖 Node 20+;**进入 kode release 验收前**必须用 `bun build --compile` 或等价方案产出 sidecar,由 Tauri 打包并做版本匹配。否则 `⌘S` 不是开箱即用,只能算开发预览。

---

## 4. 每个工程"完全独立"的边界

诉求:**core 完全独立一套,工程之间互不影响**。实现方式:

```
~/工程A(kode)/
  specops.toml          ← 工程A 的配置(选哪些 scanner / gate 严格度)
  .specops/
    registry.yaml       ← 工程A 的 spec 注册表
    state/*.json        ← scan 产物(git-ignore 或入库二选一)
    specs/              ← 工程A 的 spec 文件(事实源,入 git)

~/工程B(web)/
  specops.toml          ← 工程B 完全不同的配置
  .specops/...          ← 工程B 自己的数据,跟 A 零关系
```

- **引擎一份**(全局 / npx),所有工程共用同一个版本 → 升级一处生效(你选的"共享引擎+独立配置")。
- **数据/配置每工程独立**,放各自 `.specops/`,互不可见。
- **scanner 以插件形式扩展**:`specops-plugin-react` / `specops-plugin-rust` 各工程按需装;core 只提供插件接口 + 通用 scanner(野生 spec 检测 / spec_id 绑定检查,这俩语言无关)。

### 4.1 仓库边界(硬约束)

`apps/specops/` 是 kode monorepo 的普通子目录,**禁止在里面执行 `git init` 或提交嵌套 `.git/`**。引擎的"独立"指包边界与依赖方向独立,不是在主仓里再套一个 Git 仓库。

- `apps/specops/package.json` 可独立构建、测试、发布,但源码由 kode 根仓统一版本控制。
- 目标工程中的 `.specops/` 属于目标工程自己的 Git;SpecOps 只读写该目录和显式创建的 Run worktree。
- 将来若拆成独立发布仓,走正常 history split/subtree 流程,不在开发期制造 nested repo。

### 4.2 借鉴 kode 已验证的范式(借鉴,不依赖)

kode 里有几个已经过生产验证的架构,SpecOps 可以**在设计层面照抄思路,但一行代码都不 import**(保持完全独立):

| kode 现有模块 | 对 SpecOps 的价值 | 借鉴方式 |
|---|---|---|
| `crates/kode-memory`:facts/ 事实源 + SQLite FTS 可重建索引 + 提议→审核门槛 + 能量预算 | spec registry / drift 记录的存储层高度同源(事实源 + 索引分离) | **借鉴架构,独立实现**(TS 版自己的 store) |
| `kode-memory` git_sync(union-merge + 启动 pull→reconcile) | spec 跨机/多人同步同样需要 | 借鉴去中心化同步思路,独立实现 |
| `.specops/specs/remote-protocol.md`(REST + WS 事件流契约) | `specops serve` 的 web↔引擎通信范式 | 借鉴协议范式,独立实现 |
| `bridge/semantic.rs`(jsonl→语义事件) | `specops loop` 解析 agent 输出时用得上 | 仅当 loop 要驱动 codebuddy/claude 时借鉴 |

**红线**:SpecOps 是独立 Node/TS package,不 import kode 任何 crate;只在设计文档里引用"这个范式 kode 已经验证过了"。当前源码仍由 kode monorepo 统一版本控制(§4.1)。

---

## 5. MVP 范围(砍掉 plugin/Graph,但保留端到端闭环)

> **2026-06-18 范围拍板**:MVP **是「端到端闭环执行平台」,不是「文档工具」**。
> 即 MVP 必须能走通 `spec → 拆 task → 派给 agent 执行 → 半自动 verify → 人工断点 → 反馈回灌 → 继续/done` 这条完整链路(详见 §6;半自动妥协见 §6.8)。
> 非开发者流程**暂不考虑**(MVP 只服务开发者)。kode = **agent 执行后端**,specops 通过 kode 已有的 **Phase 9 协议(REST + WS)** 派 task / 收结果,不自带执行器、不重造 PTY/jsonl 解析。

原 `new-feat.md` §8 列了 5 大 plugin、§20 列 7 个阶段,每个都是数月工程。MVP **砍掉 plugin/Graph,但把执行闭环纳入**——MVP-1~5 是文档与治理侧,MVP-6 是半自动执行闭环(§6),MVP-7 是 kode 集成层(§6.0):

### MVP-1:冷启动迁移(最重要)
零 spec 工程怎么**增量**接入,而不是要求一次性补齐所有 spec(否则没人迁)。
- `specops init` 扫现有代码,**生成 spec 骨架草稿**(从 README / 模块结构 / 测试名推断),标 `status: draft` 待人确认。
- 允许"先注册已知不变量,其余慢慢补"——迁移是渐进的。

### MVP-2:spec_id 绑定 gate
PR / commit 必须绑定 `spec_id` / `change_id` / `bug_id`(对应 §17 第一条)。语言无关,纯文本检查。MVP 契约固定为:

- `specops gate --base <git-ref> --head <git-ref>` 检查 `(base, head]` 内**每个非 merge commit**;本地默认 `head=HEAD`,`base` 必传,避免偷偷猜错分支基线。
- 合法引用格式:`Spec: <id>` / `Change: <id>` / `Bug: <id>`,大小写不敏感,一行可有多个 ID;ID 统一匹配 `[A-Za-z0-9][A-Za-z0-9._/-]{0,127}`。
- `Spec` / `Change` 必须能在 `.specops/` registry 中解析;`Bug` 只做非空格式校验,外部 tracker 校验后置。
- CI 从 provider 环境显式传 base/head;PR 描述不作为 MVP 真值源,避免 GitHub/GitLab/TAPD provider 耦合。
- exit code:`0=pass`,`1=gate fail`,`2=配置/运行错误`;同时输出稳定 JSON(`--format json`)供 CI/console 消费。

### MVP-3:野生 spec 检测 + 疏导(注意:疏导优先于禁止,见 §7.4)
检测模块目录下的 spec-like 文件;**先生成 SPEC-LINKS 引导**,再考虑是否硬禁止。

### MVP-4:一个 drift 检测
选**最高价值的一个**:工程不变量门禁(见下)。其余 drift(contract-route / spec-test)后置。

### MVP-5:web console 的审阅对话流程(必须有,但形态从简)
`specops serve` 的「看 + 审阅(与 agent 对话完善文档)+ 改」三层能力(§2.2)。MVP 阶段:
- **看**:dashboard + spec detail + drift 列表先做最简版。
- **审阅(核心)**:打通「选中一份 spec/change → 开对话 → agent 产出文档 diff → 用户接受写回」这条端到端链路,**哪怕 UI 简陋也要先跑通这条流程**——这是 console 的立身之本,不是后置项。
- **改**:手工编辑写回作为兜底。
- agent 后端复用宿主已有 agent(§2.2 末 / §6),MVP 先只支持 kode 宿主下的 codebuddy/claude。

### MVP-6:执行闭环(本次拍板纳入 MVP,详见 §6)
让 spec/change 能真正被 agent 执行到 done,而不是停在文档。最小闭环 = §6 的 P0 六件:
- **Task 模型**:spec/change → 可独立验收的 task 列表,每个 task 绑 verify(测试/gate)。
- **Run 对象**:一次 agent 执行的生命周期(发起/观测/暂停/继续/终止),持久化每轮 patch/test/log。
- **Run 隔离**:每个 Run 在独立 Git worktree 执行,记录 base commit;diff/verify 只针对该 worktree,不读取或覆盖用户主工作区的未提交改动。
- **Agent 后端 = kode**:走 Phase 9 REST+WS,specops 当指挥台,kode 当执行器 + 观测窗。
- **结果回流 + 半自动 verify**:agent 产出 → 人点按钮在 Run worktree 跑 task 的 gate/test + 相对 base 生成完整变更集 → 判定(MVP 半自动,§6.8;全自动是 v2)。
- **人工审批断点(HITL)**:能自动判的放行;§8.5 红线项(scope/安全/DB/跨模块)弹给人审。
- **反馈回灌**:人审打回的意见 / gate 报错,自动组装成 prompt 喂回**同一会话**继续——消除"人肉传话筒"的横跳。

### MVP 开工闸门(Phase 0,少一项都不进入编码)

- [x] 仓库边界:monorepo 子包,禁止 nested `git init`(§4.1)。
- [x] spec 格式:Markdown + YAML frontmatter;正文承载说明,frontmatter 承载稳定机器字段。
- [x] state 策略:`.specops/state/`、`.specops/runs/` 为本地运行数据,默认不入 Git;Run worktree 放平台应用缓存目录(禁止嵌套在目标 repo);spec/change/archive 入 Git。
- [x] Run 隔离:一 Run 一 worktree + base commit + 独立 agent cwd;最终以 patch/cherry-pick 等显式动作回到用户工作区,不直接覆盖。
- [x] gate 输入/输出:采用 MVP-2 的显式 base/head、引用格式和退出码。
- [x] 安全启动:loopback + 随机端口 + 每进程随机 token;浏览器不持有 kode bridge token(§6.0.1)。
- [x] 审阅留痕:对话与接受/拒绝记录随 change 进入 archive;大体积原始运行日志留 `.specops/runs/`,不入 Git。

### MVP-7:kode 集成层(本轮拍板,详见 §6.0,归属 `apps/gui`)
把引擎包成 kode 的 feature —— 这部分代码在 **kode 的 `apps/gui`**(Tauri+Svelte),不在 `apps/specops`(引擎):
- **`⌘S` 唤起浮层**:选工程路径(原生文件夹选择)→ 检测 `.specops/` 有无 → 无则调 `specops init`。
- **spawn + 管理 `specops serve`**:每工作区一个引擎子进程(开发期 Node,release 为 sidecar),生命周期跟随;使用独立 child handle 管理,不把 HTTP server 塞进 PTY。
- **内嵌 webview 控台**:在 kode gui 开 webview 面板加载 console localhost URL,用户不开浏览器。
- **Phase 9 桥接**:引擎经 Phase 9 协议请 kode 建 tab,kode gui 原生观察 session 状态(idle/busy/awaiting)。
- 这条是「specops 成为 kode feature」的落地,MVP 必须有(否则就退回独立 npx 工具,失去"⌘S 一下就有"的体验)。

### MVP 明确不做(对照 new-feat.md)
- ❌ HTML Console 当工程**启动主入口**(CLI 才是);但审阅对话流程本身保留在 MVP(见 MVP-5),只是不强制所有工作都走 web
- ❌ 5 大 plugin 全上(UI / API / Data / Bug / LightSpec 后置,按宿主真实需求逐个加)
- ❌ Spec Graph 全量边(维护成本失控,见 §7.6)
- ❌ Stub Detector 当强门禁(不可靠,见 §7.2)
- ❌ action_id 强制绑定(侵入式,见 §7.3)

---

## 6. 执行闭环:Run / Task / 审计 / 反馈(MVP 核心)

> **要解决的真问题**:specops 定义了「什么是对的」(spec/gate/drift),但没定义「**谁执行、执行结果怎么回流、人在哪审、怎么反馈给 agent 继续**」。本章补齐这条闭环,并把它收进 kode gui(`⌘S` 唤起的内嵌控台),消除窗口横跳。

### 6.0 kode 集成全链路(本轮主设计,⌘S → 执行 → 回流)

用户视角的完整流程(全在 kode gui 内完成,不开浏览器、不切窗口):

```
⌘S(kode gui 里)
   │
   ▼
弹出"创建/打开 specops 控台"浮层(类似新建 session)
   │ ① 选工程路径(原生文件夹选择)
   ▼
kode 检测该路径下有无 .specops/
   ├─ 无 → 调 `specops init` 创建一套(specops.toml + .specops/ 骨架)
   └─ 有 → 直接用
   │
   ▼
kode spawn `specops serve`(每工作区一个进程,拿 localhost origin + 独立随机 token)
   │
   ▼
kode 在 gui 里开一个 webview 面板/tab 加载 console URL
   │  —— 这是 specops UI 控制台,提供:
   │     • 添加 spec
   │     • 查看某个 spec
   │     • 像文档一样修改 spec → 走审批(与 agent 对话完善,§2.2)
   │     • 对 change/task 发起执行
   ▼
用户在控台触发"执行某 spec/task"
   │  specops 先从目标 repo 的 base commit 创建 Run 专属 worktree
   │  specops 引擎经 Phase 9 协议(POST /sessions)请 kode 建 tab
   ▼
kode 新建一个 codebuddy/claude tab,cwd 指向 Run worktree → 规划 + 执行(§6.3 闭环)
   │  kode gui 原生观察这个 session 的内容/状态(idle/busy/awaiting)
   ▼
完成后(MVP:人点"运行 verify"按钮;v2:idle 事件自动触发,见 §6.8)
   │  specops 在 Run worktree 跑 verify(对照 spec)+ 相对 base 生成完整 diff → 回流 console
   ▼
控台展示:绿(done)/ 红(打回带反馈)→ 人审 → 反馈回灌同一会话继续
```

> ⚠️ **MVP 是半自动**:上图"完成后跑 verify"在 MVP 阶段由**人点按钮**触发,diff 靠 specops 自己 `git diff`——因为 Phase 9 协议缺完成信号与结构化 diff(§6.8)。全自动是 v2。

**四个已拍板的集成决策(2026-06-18 第三轮)**:

| 决策点 | 选定 | 含义 |
|---|---|---|
| 控台呈现 | **kode 内嵌 webview 面板** | `specops serve` 的 web 嵌进 kode gui,用户感知"都在 kode 里",不开浏览器 |
| 引擎生命周期 | **每工作区一个 `specops serve`** | 一个工程路径一个 Node 进程;kode spawn,生命周期跟随 |
| 执行回调 | **走 kode Phase 9 协议** | specops 引擎调 `POST /sessions`(建 tab)+ `/input`(喂 prompt)+ WS(收结果);引擎是协议客户端,不走 Tauri 直调 → 保持引擎工程无关 |
| multica 理念 | **只借编排骨架** | 借"控台↔本地执行器↔结果回流"单 agent 闭环;squad/多 agent/技能系统后置(§6.7) |

> **集成层归属**:`⌘S` 唤起、webview 面板、spawn `serve`、Phase 9 调用 —— 全是 `apps/gui`(kode)的代码,是 **kode 的 feature**。specops 引擎只管"算 + 控台 + 当 Phase 9 客户端",不知道自己被嵌着。

### 6.0.1 安全启动与凭证边界(硬约束)

`specops serve` 能改文件、运行 verify、驱动 agent,不能把它当普通静态预览服务器。MVP 固定以下契约:

1. **监听**:只绑定 `127.0.0.1:0` / `[::1]:0`,由 OS 分配端口;禁止默认监听 LAN 地址。
2. **console token**:每次启动生成高熵随机 token,kode 从子进程结构化启动消息拿到 `{origin, token}`。GUI 用 URL fragment 首次注入,console 读取后立即 `history.replaceState` 清除;HTTP API 用 bearer,WS 用 subprotocol/首帧鉴权,禁止把 token 放 query 或日志。所有写 API 同时校验 `Origin`。
3. **bridge token 不下发浏览器**:kode 通过环境变量或仅 owner 可读的匿名管道把 Phase 9 endpoint/token 交给 SpecOps Node 进程;console 浏览器只调用 SpecOps API,由 server 端 adapter 调 kode bridge。
4. **工作区约束**:启动时 canonicalize workspace root;所有 spec、state、patch 路径必须再次 canonicalize 并验证仍在允许根目录/Run worktree 内,拒绝 `..` 与 symlink 逃逸。
5. **命令约束**:前端只能触发 Run 创建时从 base commit 读取并固化的具名 verify snapshot,不能提交任意 shell 字符串,也不能信任 agent 在 worktree 里改过的 `specops.toml`。执行层用 argv 数组 spawn,不经 shell;超时、输出上限、终止信号必须配置。verify 配置自身变化一律进入人工红线审阅。
6. **生命周期**:kode 持有 child kill handle;窗口/工作区关闭时先优雅 shutdown,超时后 kill 并 wait,不得留孤儿进程。启动失败和进程退出必须在 GUI 显式展示。
7. **内嵌方式先 spike**:现有 kode 是单 Tauri webview。先验证同一页面内 `<iframe>` 的焦点、快捷键、token 注入和 localhost 导航;验证失败再采用 Tauri child webview,不先假定"开 webview 面板"天然可行。

### 6.1 为什么这套设计消除了"窗口横跳"

早期担心:kode(执行场)与 specops(裁判场)两个窗口来回切,人肉搬运 gate 结果。

```
旧顾虑:①kode 聊 → ②切 specops 跑 gate → ③切回 kode 改 → ④切 specops 重 gate → 横跳
```

**§6.0 的内嵌设计直接消除它**:控台嵌进 kode gui(同一窗口),执行也在 kode tab(同一进程视野),gate 结果由 specops 自动经 Phase 9 回灌 agent 会话——**人不再当传话筒,也不再切窗口**。这正是"specops 当指挥台、kode tab 当执行器 + 观测窗,二者同一 gui"的兑现。

### 6.2 引入 Run / Task 两个第一类公民

文档侧只有 spec/change;执行侧缺两个对象:

```
spec / change
   │  拆解
   ▼
Task(可独立验收的最小单元,绑定 verify = 测试/gate)
   │  发起执行
   ▼
Run(一次 agent 执行的生命周期)
   持有一个 agent 会话(kode 宿主 = 一个 codebuddy/claude session)
   持有一个独立 Git worktree + immutable base commit
   记录每轮:prompt / patch / test 结果 / agent 自述 / 人审记录
```

- **Task** 回答你的「调 agent 完成每个 task」里的 task 从哪来:由 spec/change 拆解,每个 task 自带验收标准(绑 test/gate)。
- **Run** 回答「结果怎么审计、怎么留痕」:一个 Run 串起一个 agent 会话,所有轮次持久化到 `.specops/runs/<run-id>/`(对应 new-feat.md §19 的 `runs/`)。

Run 最小持久化字段:`run_id / task_ids / state / workspace_root / worktree_path / base_commit / backend_key / kode_session_id / started_at / updated_at / iteration / verify_results / decisions`。状态机固定为:

```
created → preparing → running → awaiting_verify → awaiting_review
                    ↘ failed          │              │
                                      ├→ running(feedback)
                                      ├→ completed
                                      └→ cancelled
```

- 一个 Run 可顺序执行多个 Task,但始终绑定同一个 agent session 和 worktree;这澄清"一个 Task 一个 Run"与"task 间复用会话"的歧义。
- 同一目标 repo 可并发多个 Run,因为 worktree 隔离;同一个 Run 内只允许一个状态转换写者,状态文件用临时文件 + rename 原子更新。worktree 位于平台应用缓存目录的 `specops/worktrees/<repo-hash>/<run-id>`,不得建在目标 repo 内。
- `git diff` 必须相对 `base_commit`,同时纳入 tracked、staged 和 untracked 文件;不能只跑无参数 `git diff`。
- `completed` 只表示 Run 产物通过审批,不表示已自动写入用户当前分支。测试全绿最多允许自动进入下一 Task,**最终应用产物始终需要人工确认**。MVP 由用户选择导出 patch或在干净目标分支上应用;冲突必须停止并显式处理。

### 6.3 端到端闭环(消除横跳的关键)

```
            specops console(指挥台)
                   │ 选 spec/change → 拆 task → 发起 Run
                   ▼
   ┌─────────────────────────────────────────────────┐
   │  Run:specops 把 task 上下文 + spec 约束打包成     │
   │  prompt,经 Phase 9 协议派给 kode 的 agent 会话    │
   └──────────────────────┬──────────────────────────┘
                          ▼
        kode agent 在 Run worktree 执行(codebuddy/claude,走 jsonl)
        开发者可在 kode 看实时终端(同一会话,不同视图)
                          │ WS 回流文本事件(message/tool_use);diff 从 worktree 相对 base 生成(§6.8 G2)
                          ▼
        完成后在同一 worktree 跑 task 绑定的 verify(test/gate) ──── 审计
        (MVP:人点按钮触发;v2:idle 事件自动触发,§6.8 G1)
                          │
            ┌─────────────┴──────────────┐
         全绿 + 非红线                  红 / §8.5 红线(scope/安全/DB/跨模块)
            │                             │
        自动进下一 task            回流 console,人审 ──── 审计·人工断点
                                  看 diff+测试 → 接受 / 打回(带意见)/ 改 spec
                                          │
                              打回意见 / gate 报错 自动组装成新 prompt
                                          │
                                  回灌**同一个 Run 会话**,继续下一轮 ◀── 闭环
```

**三个消除割裂的设计点:**

1. **同一会话贯穿**:一个 Run = 一个 kode agent 会话。task 之间、反馈回灌都在这个会话里追加,不重开、不丢上下文。人不再当传话筒。
2. **审计 = verify + 人工断点,都在 console**:verify 跑过的(测试绿/gate 过)放行;§8.5 划红线的弹给人。人审在 console 看 worktree 相对 base 的完整 diff + 测试红绿,点接受/打回。(MVP 阶段 verify 由人点按钮触发,§6.8 G1。)
3. **两个视图,一个会话**:开发者在 kode 看实时终端流,在 specops 看结构化审计/进度。同一个 agent 会话,不是两份割裂工作——这是「kode = 执行后端」决策的兑现。

### 6.4 Agent 后端 = kode(走 Phase 9 协议)

specops **不自带执行器**,通过 kode 已有的 Phase 9 协议接入:

| specops 需要 | 复用 kode Phase 9 的 | 状态 |
|---|---|---|
| 派一个 task 给 agent | `POST /sessions`(起会话)+ `POST /:id/input`(喂 prompt,裸字节) | ✅ 就绪 |
| 收 agent 实时产出 | `GET /ws`(message / tool_use / meta 文本事件) | ✅ 就绪 |
| 解析 agent 干了啥 | `semantic.rs` 的 jsonl→语义事件(**仅文本,无 diff**) | ⚠️ 无结构化 diff,§6.8 G2 |
| 反馈回灌继续 | 同一 session 再 `POST /:id/input` | ✅ 就绪 |
| 判断"执行完了" | — | 🔴 无完成事件,§6.8 G1 |

Adapter 发送 prompt 时必须明确提交键语义:`POST /input` 的 `text` 只写原始字节,不会自动补 Enter。MVP 统一用 `bytes_b64` 发送 `UTF-8 prompt + \r`,并为 codebuddy/claude 做真实 PTY 集成测试;反馈回灌同样如此。

> specops 引擎是 Phase 9 协议的**又一个客户端**(与 Flutter app、Go server 平级);MVP adapter 不要求改协议端点,但 kode GUI 集成层必然要新增 spawn/内嵌/生命周期代码。全自动仍需 bridge 增强(§6.8 列了 4 项)。
> 跨宿主的 `AgentBackend` 抽象接口**后期再抽**(开放问题 §9):MVP 先硬绑 kode 验证闭环,证明后再泛化到其他宿主。

### 6.5 还差哪些功能(P0 = 闭环最小集,少一条就断回横跳)

| # | 功能 | 解决 | 优先级 |
|---|---|---|---|
| 1 | Task 模型 + 拆解(spec/change → 带 verify 的 task) | task 从哪来 | **P0** |
| 2 | Run 对象 + 生命周期 + worktree 隔离 + 每轮持久化(`.specops/runs/`) | 结果留痕/审计,不污染用户工作区 | **P0** |
| 3 | kode 后端 adapter(Phase 9 REST+WS 客户端) | 怎么真正调 agent | **P0** |
| 4 | 结果回流 + **半自动** verify(人点按钮跑 gate/test;变更集来自 worktree vs base,§6.8) | 审计·自动部分 | **P0** |
| 5 | 人工审批断点 HITL(接受/打回/改 spec,§8.5 红线弹人) | 审计·人工断点 | **P0** |
| 6 | 反馈回灌(打回意见/gate 报错 → 组 prompt → 回同一会话) | 闭环的"继续" | **P0** |
| 7 | Run 实时视图(idle 轮询 + WS 文本事件,推当前 task/轮次/红绿) | 看进度 | P1 |
| 8 | 停止条件(max_iterations / same_error_repeated / touched_files_exceed) | 防 agent 空转烧钱 | P1 |
| 9 | 审计追溯(spec ↔ 它的 Run 历史:谁/何时/几轮/最终 diff/人审) | "这条 spec 怎么被实现的"可回溯 | P2 |
| — | **(v2)** Phase 9 协议增强:status_changed 事件 / verify-trigger / 结构化 diff / plan_response 落地 | 全自动闭环前置 | v2,§6.8 |

**P0 六条 = MVP-6 的全部**(注意 #4 是半自动)。停止条件(8)虽列 P1,但建议跟 P0 一起做最小版(否则首次 dogfood 就可能被空转 Run 烧钱)。

### 6.6 使用模式(MVP 只做开发者两种)

| 模式 | 形态 | MVP |
|---|---|---|
| 开发者-内嵌控台(主) | `⌘S` 唤起 → console 嵌 kode webview 面板派 task/审计/反馈 + kode tab 当执行器/观测窗,同一 gui(§6.0) | ✅ MVP |
| 开发者-纯 CLI | 不开 console,`specops run <task>` 终端里跑闭环,gate 进 CI(引擎独立跑,不嵌 kode) | ✅ MVP |
| 非开发者-仅 console | 三态视图(需求/执行中/待验收),终端与报错全被消化成人话 | ❌ 暂不考虑(本次拍板) |

### 6.7 与 multica 的对照:借编排骨架,补验收闸门

[multica](https://github.com/multica-ai/multica) 是开源的"托管 agent 平台"——web dashboard 派 task,本地 daemon spawn 各家 runtime 执行,结果回 server 追踪。**它的骨架与本设计高度同构**:

| 维度 | multica | kode + specops |
|---|---|---|
| 控制台 | Web Dashboard(Next.js,远程) | specops console(⌘S 唤起,嵌 kode webview) |
| 执行器 | 本地 daemon spawn runtime | kode tab(codebuddy/claude session) |
| 任务下发 | server 派 → daemon claim | console 触发 → Phase 9 建 tab |
| 结果回流 | daemon report → server | tab 完成 → 半自动 verify(§6.8)→ 回 console |
| 观测 | dashboard 远程看进度 | **kode gui 原生观察 session**(更强) |
| **验收/约束** | **❌ 无 spec、无 approval gate** | **✅ specops spec/gate/审批** |

**决定性差异 = specops 的价值点**:multica 解决"派活、追踪、技能复用",但**没有验收闸门**——agent 说做完就做完。specops 的 spec/gate 把"无验收的派活"升级成"**spec 约束下的闭环执行**":agent 干完 → 自动对照 spec verify → 不达标打回。这是 multica 缺的一层。

**结合方式(本次拍板:只借编排骨架)**:
- **借**:multica 已验证的"控台 ↔ 本地执行器 ↔ 结果回流"单 agent 闭环范式(§6.0/§6.3 的骨架与之同构)。
- **不借(后置 v2)**:squad / 多 agent 并行 / 技能注入系统 / 中心 server。MVP 聚焦单 agent 闭环跑通。
- **kode 比 multica daemon 强的地方**:kode gui 本来就能可视化观察 session(idle/busy/awaiting),multica 要靠 dashboard 远程拼。kode 当"带 UI 的本地执行器",观测体验天然更好。

### 6.8 Phase 9 协议依赖与缺口(⚠️ 落地前必读,决定 MVP 是半自动)

> **2026-06-18 review 实测发现**:§6 闭环原本画成"执行结束 → 自动 verify"的全自动链路,但对照 kode 现有 Phase 9 协议代码(`crates/kode-bridge/src/lib.rs` + `semantic.rs` + `.specops/specs/remote-protocol.md`)实测,**三个核心假设不成立**。下次接手实现时会直接踩这三个坑。

| # | 闭环假设 | 协议现实 | 影响 |
|---|---|---|---|
| G1 | "执行结束"有信号 → 自动触发 verify | 🔴 **无 `session.status_changed` 事件**;idle/busy 只能 `GET /sessions/:id` 轮询(`lib.rs:458,471-478`) | 自动闭环的**起跑信号拿不到** |
| G2 | 从 WS 拿 agent 产出的**结构化 diff** | 🔴 协议只有 message/tool_use **文本**事件,无 diff/patch 结构(`semantic.rs` / PROTOCOL.md 全文无) | console 拿不到结构化 diff |
| G3 | HITL 走 plan/ask 回应 | 🟡 `/answer` 能用(`lib.rs:646`);**`/plan_response` 仍 501 占位**(`lib.rs:674-682`) | plan 类审批闭环走不通 |
| — | task 当 prompt 喂回 | ✅ `POST /input` 就是往 PTY 写裸字节(`lib.rs:617-635`),能用但粗糙 | 可用 |

**根因**:codebuddy/claude 是**交互式 PTY**,没有"任务完成"的明确信号;kode 靠 `heuristic.rs`(N ms 无字节=idle)猜,但这个信号**没经 bridge 暴露成事件**。

**结论:MVP-6 降级为「半自动」,不追求全自动闭环:**
- **G1 缓解(完成信号)**:console 显示**"我已完成,运行 verify"按钮**由人点触发(替代缺失的自动完成信号);辅以 idle 轮询给个进度提示。
- **G2 缓解(diff)**:**不靠协议拿 diff**,specops 对 Run worktree 生成相对 immutable `base_commit` 的完整变更集,包含 tracked/staged/untracked。禁止直接对用户主工作区跑无参数 `git diff`。
- **G3 缓解(plan)**:plan 类审批**先不进 MVP 闭环**,等 `/plan_response` 落地;MVP 只覆盖普通 task。

**全自动闭环是 v2,且依赖 kode bridge 增强**(这些是 SpecOps 对 kode 的反向需求,需 kode 侧配合):
1. `session.status_changed` WS 事件(idle/busy/awaiting/exited 转换时推送)——免轮询。
2. verify-trigger 钩子或 idle 事件 → specops 自动跑 verify。
3. (可选)结构化 diff 事件,免 specops 自己 `git diff`。
4. `POST /plan_response` 从 501 占位落地。

> 沉淀:见 kode-memory fact `01KVDAA9F…`(specops/phase9/protocol/gotcha)。

---

## 7. kode 作为首个宿主的迁移剧本

kode 是理想的 **hard case**:零 spec + 多语言(Rust/Tauri/Go/Flutter)+ 非标。能迁 kode 就证明工程无关。

### 7.1 把 kode 的人肉不变量变成 specops gate
kode 今天靠 `CODEBUDDY.md` / `ROADMAP.md` 人肉记的回归约束,没有自动门禁。迁移就是把它们落成 gate:

| kode 现有人肉约束(出处) | 落成 specops gate |
|---|---|
| codebuddy args 不能加 positional(CODEBUDDY.md / 回归测试 `default_codebuddy_backend_has_no_positional_args`) | gate:改 `config.rs` backend 默认 args 时校验无 positional |
| PtyHost::kill 用独立 killer 避免死锁(CODEBUDDY.md 坑#3) | gate:`pty/mod.rs` 出现 `Arc<Mutex<Child>>` 同时 wait+kill → fail |
| 外层 kode 绝不进 alt-screen(坑#1) | gate:`main.rs` 出现 `EnterAlternateScreen` → fail |
| PTY→像素 P99 < 16ms(ROADMAP 硬指标) | gate:性能测试结果回写,超阈值 → fail(需 benchmark 产物) |
| memory 关键不变量(ROADMAP §481-492,如 facts/ 是事实源、prompt 注入尊重用户) | gate:对应文件改动时提醒绑定 spec_id |

### 7.2 迁移步骤(渐进)
1. `npx specops init` → 在 kode 仓生成 `specops.toml` + `.specops/`,扫出模块骨架草稿。
2. 人工把上表 5 条不变量写成 spec(`status: active`),其余模块标 `draft` 慢慢补。
3. `specops gate` 接进一个最小 CI(kode 目前零 CI,这本身就是收益)。
4. `specops serve` 本地看覆盖矩阵 + drift,并验证审阅 console:选一条 spec,用「与 agent 对话完善文档」流程改一版写回(§2.2)。
5. **跑通半自动执行闭环(§6,妥协见 §6.8)**:挑一个 task(如「给 config.rs 加 backend 字段」),console 发起 Run → 创建独立 worktree → 经 Phase 9 派给 kode codebuddy 会话(agent cwd=worktree)→ agent 改代码 → 人点"运行 verify"跑 `cargo test` + 看相对 base 的完整 diff → 绿则批准产物,红则人审打回 + 反馈回灌。最后显式把 patch 应用回目标分支。这是 dogfood 的**主验收场景**。

### 7.3 这一步同时帮 kode 补齐:CI
kode 目前 `.github` / git hooks 全空。MVP 落地的副产品就是给 kode 一个最小 CI(`cargo test` + 上述 gate)——这是独立于 SpecOps 也该做的事(见 kode-memory fact `01KVCSNGH…` 第三条路线)。

### 7.4 审阅对话 agent 与执行 loop 共用一套后端

§2.2 审阅 console 的「对话完善文档」与 §6 执行闭环的「派 task 跑 loop」,本质都需要一个**能读上下文、产出 diff 的 agent** —— MVP 阶段**共用同一个 kode 后端(Phase 9 协议)**,只是产出物不同:

- **审阅对话**:agent 产出**文档 diff**,永远 human-in-the-loop(用户接受才写回 spec)。
- **执行 loop**:agent 产出**代码 diff + 测试结果**,自动 verify 能过的自动放行,§8.5 红线项才弹人(见 §6.3)。

两者都走「specops 喂上下文 → kode agent 干 → 解析 jsonl 产出 → specops 管状态机」这条统一路径。跨宿主的 `AgentBackend` 抽象接口后期再抽(§9 开放问题),MVP 硬绑 kode 验证。

---

## 8. 修正 new-feat.md 原文档的 7 个缺陷

原 `new-feat.md` 有几个设计问题必须一并修正,否则会带病上线:

### 8.1 范围爆炸 / MVP 不 MVP
原 §8 五大 plugin + §20 七阶段,且 §20 第四阶段才到 UI Plugin,而 §2.1 说 UI 空壳才最痛——优先级与痛点排序自相矛盾。
**修正**:MVP 只做 §5 那 7 件(MVP-1~7,含半自动执行闭环 + kode 集成),plugin 按宿主真实痛点逐个加,不预先全列。

### 8.2 Stub Detector 不可靠(原 §9.8)
靠 grep `TODO` / `throw not implemented` / `empty onClick` 判空实现:假阳性高(合法 `// TODO(v2)`、防御式 `throw`)、假阴性更高(返回 hardcoded 数据的"假实现"grep 抓不到)。启发式当强门禁会被当噪音关掉。
**修正**:Stub 检测降级为**警告/报告**,不当 hard gate;真正的"空实现"靠 ActionSpec↔测试绑定(有断言的 e2e 跑过)来证伪,而非 grep 关键词。

### 8.3 action_id 绑定侵入且跨框架不统一(原 §9.7)
要求每个按钮加 `data-action-id`(React)/ `Key()`(Flutter),让业务代码为治理系统打标,且每框架要写一套 parser,维护成本被低估。
**修正**:action_id **可选**;优先用框架已有的可访问性/测试 id(`data-testid` / a11y label)做关联,不强制新增侵入式标记。

### 8.4 野生 spec 治理过严会反弹(原 §12)
CI 硬禁 `src/**/spec.md`,但开发就是想在代码旁写需求;强堵会让人把 spec 藏进 `notes.md` 绕检测。原文把"禁止"放在"疏导"前面,顺序反了。
**修正**:**疏导优先**——先自动生成 SPEC-LINKS(§12.5)把 canonical spec 拉到代码旁;野生 spec 默认**警告**,只有团队显式开启严格模式才升级为 fail。

### 8.5 AI 角色与 Loop 隐含矛盾(原 §14 vs §16)
§14 说 AI 不能决定 scope/架构/合并,但 §16.3 Build Loop 让 AI 自动 patch→test→patch 到绿——自动改代码到测试绿实质是在做实现决策。边界没划清。
**修正**:已在 §6.3 落地为执行闭环的**人机断点**——自动放行项(测试绿 + 非红线)vs **本节定义的"红线"必须人审项**(scope 变更 / 跨模块 / 安全敏感 / DB schema)。停止条件(`same_error_repeated` / `touched_files_exceed` / `security_sensitive_change_detected`)见 §6.5 功能 #8。§6 各处引用的「§8.5 红线」即指本清单,执行闭环 §6.3 据此分流。

### 8.6 Spec Graph 维护成本被忽略(原 §18)
要维护 spec↔module↔api↔test↔PR↔bug↔release 全量边,但没说**边的真值从哪来、谁保证不腐烂**。靠 AI 推断就是新的 drift 来源。
**修正**:MVP **不做全量 Graph**;只维护**能从代码/git 确定性推导的边**(spec_id 在 commit message / 文件路径 glob 匹配),不让 AI 猜边。Graph 是 v2 话题。

### 8.7 SpecOps 与 OpenSpec 边界模糊(原 §5)
没说清 SpecOps 是 fork / wrap / 平行于 OpenSpec,`SpecOps Core` 的 registry/graph/workflow 与 OpenSpec 的 changes/archive 职责重叠,易做成两套打架的状态机。

**修正(已拍板:抽取核心,不包装):SpecOps 借鉴 OpenSpec 的核心模型,自己用 TS 重新实现一份精简内核,而非把 `openspec` 当依赖包包起来。**

理由——为什么选「抽取」而非「wrap」:
- **形态匹配**:OpenSpec 是面向 AI 编码助手的 SDD 框架,核心交付物是各 AI 工具的 slash command / Agent Skills 适配(`/opsx:*`、Claude/Cursor/Cline 等 11+ 适配器)。SpecOps 要的是**引擎能力**(scan/gate/drift + 审阅 console),不是又一套 slash command 分发器。wrap 它会同时背上一堆与 SpecOps 无关的适配层。
- **耦合风险**:wrap 意味着 SpecOps 的状态机受 OpenSpec 版本/schema 变更牵制,而我们恰恰想要一份**自己可控、可裁剪**的轻量内核。
- **核心其实很小**:OpenSpec 真正值钱的是它那套**已被验证的概念模型**,这部分抽出来用 TS 重写成本可控,不必为它引一个外部依赖。

**从 OpenSpec 抽取的最核心三件(用 TS 重新实现):**

| OpenSpec 概念 | SpecOps 如何抽取实现 |
|---|---|
| **specs/**(事实源 spec) | SpecOps 自己的 `.specops/specs/`,MD+frontmatter,`scan` 可重建索引 |
| **changes/**(提案 → 审阅 → 实现) | SpecOps 的 change 流转;**审阅环节直接对接 §2.2 的「与 agent 对话完善文档」**——这正是 OpenSpec「propose → review → implement」里 review 阶段的具体化 |
| **archive/**(完成后归档,保留演进史) | SpecOps 归档目录,change 落地后归档,供回溯「这条 spec 为什么这么写」 |

**不抽取**:OpenSpec 的多 AI 工具适配层(`/opsx:*` slash command 对 11+ 工具的分发)、schema 自定义体系——这些超出 SpecOps 引擎范畴,需要时再说。

**边界总结**:SpecOps = OpenSpec 的核心三件(spec/change/archive 模型)用 TS 精简重写 + SpecOps 独有外层(registry / gate / drift / 带 agent 审阅的 web console)。**一行 `openspec` 代码都不依赖,只继承它验证过的概念模型。**这与 §4.2「借鉴 kode 范式但不 import kode」是同一条原则。

---

## 9. 已冻结决策与后置问题

### 9.1 MVP 已冻结

1. **OpenSpec**:抽取 spec/change/archive 三个概念用 TS 重写,不 wrap、不依赖 `openspec` 包。
2. **文件格式**:spec/change/archive 使用 Markdown + YAML frontmatter;schema 带 `schema_version`。
3. **Git 策略**:spec/change/archive 入 Git;state/runs/worktrees 默认不入 Git。
4. **执行隔离**:一 Run 一 Git worktree,所有 diff/verify 相对 immutable base commit。
5. **审阅留痕**:结构化结论随 change 归档;原始大日志留本地 runs。
6. **Agent 后端**:MVP 只实现 kode Phase 9 adapter,但代码放在 adapter 边界后,不把 HTTP 调用散落进 domain 层。
7. **自动化程度**:MVP 人工点击触发 verify;不把 idle 猜测包装成可靠完成信号。
8. **分发**:开发预览允许 Node 20+;kode release 必须打包 sidecar。

### 9.2 验证后再决定

- 跨宿主 `AgentBackend` 公共协议:等 kode adapter 完整 dogfood 后抽取,避免预设计错误抽象。
- iframe 还是 Tauri child webview:由 Phase 7 spike 的焦点、快捷键、导航安全结果决定。
- patch 回主分支的最终 UX:先支持导出 patch + 明确应用,再评估自动 cherry-pick。
- Phase 9 全自动增强:`session.status_changed`、verify trigger、结构化 diff、`plan_response` 都放 v2。

---

## 10. 实施任务拆解

> 顺序按风险递减排列。每个 Phase 必须满足验收条件再进入下一阶段;避免先堆完整 UI,最后才发现执行闭环不可行。

### Phase 0 — 设计冻结(完成)

- [x] 确认 monorepo package 边界,删除 nested `git init` 方案。
- [x] 冻结 spec 格式、state Git 策略、gate base/head 与退出码。
- [x] 冻结 Run worktree 隔离与 base commit 语义。
- [x] 冻结 loopback/token/path/verify 命令安全边界。
- [x] 明确开发期 Node 与 release sidecar 两阶段分发。

**验收**:本文档 §4.1、MVP-2、§6.0.1、§6.2、§9 不再保留会阻塞编码的开放决策。

### Phase 1 — Node/TypeScript 工程骨架(完成)

- [x] 创建 `apps/specops/package.json`、`tsconfig.json`、lockfile、Node 20 engines 声明。
- [x] 建 `src/cli`、`src/domain`、`src/store`、`src/server`、`src/adapters` 分层;domain 不 import server/kode adapter。
- [x] CLI 支持 `--help`、结构化错误、统一 exit code;接入单测、类型检查和 build。
- [x] 更新根 `.gitignore`:忽略 `apps/specops/node_modules`、dist 和目标工程本地 state/run 约定;不创建 `.git/`。

**验收**:`pnpm test && pnpm check && pnpm build`;产物可从临时目录运行 `specops --help`。

### Phase 2 — spec/change/archive 内核 + init/scan(完成)

- [x] 定义 versioned frontmatter schema、ID 规则、状态迁移和诊断结构。
- [x] 实现安全路径解析、原子写入、registry 重建;损坏文件报定位明确的诊断,不部分写盘。
- [x] `specops init`:生成最小 `specops.toml` 与目录骨架;重复执行幂等,不覆盖用户内容。
- [x] `specops scan`:从事实源重建 `.specops/state/*.json`;支持删除 state 后完全重建。
- [x] 冷启动草稿先做确定性扫描(README/目录/测试名);AI 推断只作为后续可选步骤,不混进可重复 scan。

**验收**:临时 Git repo 覆盖 init 幂等、schema 错误、symlink 逃逸、state 删除重建和 Windows/macOS/Linux 路径测试。

### Phase 3 — gate/drift + kode 首轮 dogfood(完成)

- [x] 实现 `gate --base --head [--format json]` 与三类引用解析。
- [x] 实现具名 verify 配置:argv、cwd、timeout、输出上限;禁止前端/配置走隐式 shell。
- [x] 实现野生 spec warning 与 SPEC-LINKS 疏导;strict fail 必须显式开启。
- [x] 把 kode 现有高价值不变量登记为首批 spec/gate,先复用现有测试,不写脆弱源码 grep 冒充语义检查。
- [x] 增加最小 CI:Rust 基线测试 + SpecOps 自身测试 + dogfood gate。

**验收**:构造 pass/fail/error commit range,exit code 和 JSON 稳定;kode 当前 HEAD gate 通过。

### Phase 4 — 安全 serve + 最小 console(完成)

- [x] server 绑定 loopback 随机端口,输出单行 JSON ready 消息;所有 API/WS 校验 console token 与 Origin。
- [x] API 提供 dashboard、spec detail、diagnostics、手工编辑;所有写操作做 schema/path/并发版本校验。
- [x] 最小 SPA 展示 spec/change/drift,支持编辑预览 diff 后写回。
- [x] 测试未授权、错 Origin、目录穿越、symlink 逃逸、并发编辑冲突、child shutdown。

**验收**:删 state 后重启 console 可恢复;未经授权的本地网页不能读写 workspace。

### Phase 5 — Task/Run + worktree + kode adapter(完成)

- [x] 实现 Task schema、Run 状态机、原子持久化和崩溃恢复。
- [x] 创建/清理 Run worktree,记录 base commit;完整采集 tracked/staged/untracked diff。
- [x] 实现 Phase 9 REST/WS adapter:spawn、带 `\r` input、history、kill、重连与错误映射。
- [x] agent session cwd 必须指向 Run worktree;Run/Session 映射持久化。
- [x] MVP 停止条件:人工 cancel 与 `max_iterations`;verify 同时受 timeout 和输出上限约束。

**验收**:脏主工作区保持字节级不变;两个 Run 可并发且 diff 不串;进程重启后能识别并恢复/终止遗留 Run。

### Phase 6 — 审阅与半自动闭环(完成)

- [x] spec/change 审阅和代码执行共用 Run 基础设施,但产物类型与审批规则分开。
- [x] 人工按钮触发 verify;保存 exit code、耗时和受上限保护的 stdout/stderr。
- [x] console 展示相对 base 的完整 diff、verify 结果和红线提示。
- [x] 接受/拒绝/反馈形成结构化 decision;反馈追加到同一 kode session。
- [x] 批准后导出 patch并显式应用;冲突不自动覆盖。

**验收**:完成"失败 → 打回 → 同会话修复 → verify 通过 → 应用 patch"全链路,审计记录可回放。

### Phase 7 — kode GUI 集成(完成)

- [x] `⌘S` + Command Palette 打开工作区选择/最近项目浮层;不影响终端快捷键。
- [x] Tauri 管理每工作区一个 SpecOps child,安全传 bridge 凭证,处理 ready/exit/restart/shutdown。
- [x] 采用 iframe 隔离 console;父窗口校验消息 origin,console 导航由 CSP 限定到 loopback。
- [x] 收紧 kode 当前 `csp: null`:只允许打包资源和 loopback console,禁止任意外站。
- [x] console 创建的 session 在原生 tablist 可见;从 console 可跳转到对应 terminal tab。
- [x] 开发模式找 Node 包;release 模式只找随包 sidecar,缺失时给明确错误。

**验收**:从 `⌘S` 到创建 Run、观察 agent、verify、应用 patch 全程不离开 kode;关闭窗口无残留 server/agent child。

### Phase 8 — release 与端到端验收(本机验收完成)

- [x] kode 仓按 §7 完成首次真实 dogfood,结果记录在 `PERFORMANCE.md`。
- [x] 自动化覆盖 worktree 隔离、未跟踪 diff、显式应用、状态恢复、server 关闭和 bridge 错误映射。
- [ ] 编译 SpecOps sidecar并接 Tauri bundle;macOS arm64 无签名 bundle 已验证。Linux 架构与正式签名由 CI/发布证书环境验证。
- [x] 建性能基线:scan 时间、内存、空闲 CPU、sidecar/app 体积;不得破坏 kode 原有终端渲染指标。
- [x] 文档补 CLI reference、配置 schema、故障恢复和安全模型。

本机验收环境无法提供发布签名证书和 Linux runner;这两项属于发布流水线验证,不阻塞 macOS MVP 实现。内置浏览器在验收时不可用,GUI 已通过 Svelte 类型检查、production build、Tauri bundle 和应用启动 smoke test,但保留一次发布前人工视觉走查。

**MVP 完成定义**:全新 Git 工程可 init/scan/gate;用户可在 kode 内审阅 spec,在隔离 worktree 发起 agent Run,半自动 verify 并安全应用产物;失败全程可恢复且不污染用户原工作区。

### v2 — 验证价值后再做

- [ ] Phase 9 `session.status_changed`、verify trigger、可选结构化 diff、`plan_response`。
- [x] 文档类型拆分为 normative spec 与 work item；只有 work item 绑定 workflow。
- [x] SpecGraph/ProductGraph、mapping/diff、Completion Contract、Evidence Ledger 基础控制面。
- [x] Impact/Risk/Policy、可复现 RunManifest、Task DAG 与 Assurance Console。
- [ ] 自动完成触发、多 agent/squad、跨宿主 adapter、AST/runtime 专用语言 adapter、更多语言 plugin。
