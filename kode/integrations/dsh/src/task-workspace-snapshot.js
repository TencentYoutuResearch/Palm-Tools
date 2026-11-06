/** Bind starting bytes to a frozen Git base, upstream artifact or the prior rework artifact. */
import { captureArtifactSnapshot } from './artifact-snapshot.js'
import { artifactSnapshotHash } from './artifact-archive.js'
import { taskBaseTreeHash } from './task-worktree-git.js'
export async function taskStartingSnapshot(runtime, assignment, repository, workspace, signal) {
  await runtime.taskWorktrees.validate(workspace)
  const expected = assignment.task_workspace_input
  if (!expected || !['git_base', 'frozen_artifact', 'rework_artifact', 'owner_resumed_task'].includes(expected.basis)) throw Error('Frozen task starting content basis unavailable')
  const snapshot = await captureArtifactSnapshot({ workspaceRoot: workspace.root, repositoryId: repository.repository_id, signal })
  const snapshot_hash = artifactSnapshotHash({ kind: 'artifact', snapshot })
  if (snapshot.base_revision !== workspace.base_commit) throw Error('Task starting Git base changed')
  if (expected.basis === 'git_base') {
    if (snapshot.tree_hash !== await taskBaseTreeHash(workspace.root, workspace.base_commit)) throw Error('Initial task checkout differs from its fixed Git base')
  } else if (expected.basis !== 'owner_resumed_task' && (snapshot_hash !== expected.snapshot_hash || !Number.isSafeInteger(expected.source_sequence) || expected.source_sequence < 1)) {
    throw Error('Task checkout differs from its frozen input artifact; explicit source mapping is required')
  }
  signal?.throwIfAborted()
  return { ...expected, snapshot_hash }
}
