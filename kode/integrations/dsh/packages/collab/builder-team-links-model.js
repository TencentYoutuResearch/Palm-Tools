export function builderTeamLinkRows(value) {
 if(value?.team_link_status!=='accepted'||!Array.isArray(value.team_links))return []
 return value.team_links.filter(row=>row?.source==='owner_acceptance'&&typeof row.team_id==='string'&&row.team_id&&Number.isSafeInteger(row.team_revision)&&row.team_revision>0&&Number.isSafeInteger(row.draft_revision)&&row.draft_revision>0&&typeof row.request_id==='string').slice(0,100)
}
