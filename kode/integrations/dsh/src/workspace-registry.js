/** Kode owns workspace identities and durability. The dsh registry is an in-memory domain view. */
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { Service } from '@deepseek-ai/cordis'
export default class KodeWorkspaceRegistry extends WorkspaceRegistry {
  async [Service.init]() {
    await super[Service.init]()
    // Re-account known session paths, without creating projects from dsh history.
    const headers = (await this.ctx.sessionPersistence.list()).map(row => row.header)
    for (const header of headers) {
      if (!header.cwd) continue
      let workspace
      try { workspace = await this.resolveByPath(header.cwd) } catch { continue }
      if (workspace && !workspace.sessionIds.includes(header.id)) await workspace.attachSession(header.id)
    }
  }
  async initializeDefault() { return undefined }
}
