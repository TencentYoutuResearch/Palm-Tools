/** Read public immutable references only; the managed Builder's caller must revalidate its grant/draft. */
export async function readBuilderVerificationReference(runtime,draft,input){
 const keys=['runner_id','command_id','revision'],valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
 if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==[...keys].sort().join(',')||keys.some(k=>!valid(input[k])))throw Error('Exact registered command identity required')
 if(runtime.closed||draft?.home_hub!==runtime.host||draft.status!=='draft'||!draft.interview?.workspace_refs?.some(w=>w.host_id===runtime.host)||!runtime.verificationRunners)throw Error('Local selected-workspace command registry unavailable')
 await runtime.ready
 if(runtime.closed)throw Error('Command registry unavailable')
 return {host:runtime.host,reference:runtime.verificationRunners.reference(input.runner_id,input.command_id,input.revision),execution_performed:false,registration_performed:false}
}
