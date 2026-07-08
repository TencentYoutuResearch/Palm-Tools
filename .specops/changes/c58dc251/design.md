# Design

## 「异常」的本质:磁盘真相 vs 索引快照 的不一致

SpecOps 有两个并行的真相来源:

1. **磁盘 / git**:`.specops/changes/**` 与 `.specops/specs/**` 的实际文件。
2. **状态索引**:`.specops/state/registry.json`(机器读,console/gate/drift 都依赖它)+ `.specops/state/SPEC-LINKS.md`(人读索引)。

二者**靠一次显式的「重生成」步骤同步**,不是实时镜像。`gui-dark-mode-tab-grid-bg` 的 intake 写了磁盘文件、git 提交也带上了它,但那次提交**没有重跑重生成**,于是 registry 停留在 `2026-06-29T11:59:03Z` 的旧快照 —— 该快照里根本没有这个变更。结果:文件夹「存在但隐形」,这就是用户看到的「异常」。

## 为什么判定为「索引漂移」而非「文档损坏」

逐一排除了其它可能:

| 假设 | 核验 | 结论 |
|---|---|---|
| 文档结构缺章节 | proposal 含 Motivation/Scope/Acceptance/Out of scope | 排除 |
| 代码行号过时 | App.svelte 1457/1464-1466/1471/2279、Terminal.svelte 1196 等均仍命中 | 排除 |
| intake 失败 | `01f7c58e` 收据 `status=completed` | 排除 |
| 没进 git | HEAD `8ab8aaa` 含全部四个文件 | 排除 |
| **不在索引** | grep registry/SPEC-LINKS 零命中 | **命中,这就是根因** |

## 为什么本调查只诊断、不修复

- 修复 = 改 `.specops/state/registry.json` / `SPEC-LINKS.md`(状态文件,机器生成),应由 SpecOps 的索引重生成流程产出,而非手工编辑,以免引入新的不一致。
- 按 constitution guardrail「Implementation requires explicit approval」,修复属实现动作,需独立 change + 审批。
- 本任务边界(intake 提示)明确:只在 `.specops/` 下写文档,不执行修复。

## 与既有 change 的关系

- 这与 `cleanup-specops-document-staleness`、`fix-gate-errors-and-intake-ordering` 是同一类「索引/文档漂移」家族问题。若要做引擎侧自动重生成,建议合并到那条线一起评估,避免重复立项。

## 不做的事

- 不手工编辑 registry/SPEC-LINKS。
- 不修 dark 模式网格本身(归 `gui-dark-mode-tab-grid-bg`)。
- 不碰源码、不碰 TUI `src/ui/`(已冻结)。
