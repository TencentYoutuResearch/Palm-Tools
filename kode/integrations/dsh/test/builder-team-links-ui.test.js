import test from 'node:test'
import assert from 'node:assert/strict'
import {builderTeamLinkRows} from '../packages/collab/builder-team-links-model.js'
const link={team_id:'team',team_revision:2,draft_revision:3,request_id:'accept',source:'owner_acceptance'}
test('only exact owner acceptance provenance becomes a displayed team association',()=>{
 assert.deepEqual(builderTeamLinkRows({team_link_status:'accepted',team_links:[link]}),[link])
 for(const value of [{team_link_status:'unknown',team_links:[link]},{team_link_status:'accepted',team_links:[{...link,source:'title_guess'},{...link,team_revision:0},{...link,draft_revision:'3'}]}])assert.deepEqual(builderTeamLinkRows(value),[])
})
test('unknown history and multiple truncated links do not select a current target',()=>{
 assert.deepEqual(builderTeamLinkRows({team_link_status:'unknown'}),[])
 assert.deepEqual(builderTeamLinkRows({team_link_status:'accepted',team_links:[link,{...link,team_id:'other'}],team_links_truncated:true}).map(row=>row.team_id),['team','other'])
 assert.equal(builderTeamLinkRows({team_link_status:'accepted',team_links:Array(101).fill(link)}).length,100)
})
