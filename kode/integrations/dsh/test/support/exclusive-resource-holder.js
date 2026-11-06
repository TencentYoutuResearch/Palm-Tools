import { ExclusiveResources } from '../../src/exclusive-resources.js'
const locks=new ExclusiveResources(process.argv[2])
await locks.acquire(['fixture-device'],'child')
process.send({state:'held'})
setInterval(()=>{},1000)
