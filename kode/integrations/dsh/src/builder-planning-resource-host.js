/** Original Host service projections only; no discovery process or authority writes. */
import { createBuilderPlanningResources } from './builder-planning-resources.js'
import { createInteractiveTeamCatalog } from './interactive-team-catalog.js'
import { projectPluginCatalog } from './plugin-catalog.js'
export function createHostBuilderPlanningResources({ ctx, service, home }) {
  return createBuilderPlanningResources({ home,
    readCatalog: createInteractiveTeamCatalog({ service, home }),
    workspaceRegistry: { list: () => {
      const registry = ctx.get('workspaceRegistry')
      if (typeof registry?.list !== 'function') throw Error('Workspace registry unavailable')
      return registry.list()
    } },
    readPluginMetadata: async () => {
      const inventory = ctx.get('pluginInventory')
      if (typeof inventory?.list !== 'function') throw Error('Plugin inventory unavailable')
      return projectPluginCatalog({ inventory: await inventory.list() })
    },
  })
}
