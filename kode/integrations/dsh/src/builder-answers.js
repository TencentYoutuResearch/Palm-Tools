/** Owner UI answer bridge. Never exposed in the official Builder tool projection. */
export function registerBuilderAnswers(ctx, config) {
  return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/answer',handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(req.method!=='POST')return send(405,{error:'POST required'})
    if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
    try{
      if(!config?.backendClient)throw new Error('backend unavailable')
      let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>131072)throw new Error('request too large')}
      const input=JSON.parse(body)
      if(!input||typeof input.draft_id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(input.draft_id)||Object.keys(input).some(k=>!['draft_id','request_id','expected_revision','answers','clear_answers'].includes(k)))throw new Error('invalid answer request')
      const {draft_id,...command}=input
      send(200,await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft_id)}/answers`,command))
    }catch{send(400,{error:'Builder answer rejected; refresh the draft and verify its revision and question IDs'})}
  }})
}
