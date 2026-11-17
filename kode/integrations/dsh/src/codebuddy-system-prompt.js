/** Original CodeBuddy 2.182 CLI option arities (Commander declarations).
 * Never interpret a required option's value as another option. Unknown option
 * syntax fails closed only when trusted append is needed; ordinary argv is intact.
 * No import/execution of the CLI, no prompt replacement or user-message fallback. */
const required=new Set('--output-format --input-format --json-schema --permission-mode --permission-mode-before-plan --subagent-permission-mode --tools --allowedTools --disallowedTools --mcp-config --channels --dangerously-load-development-channels --worktree-branch --model --text-to-image-model --image-to-image-model --fallback-model --add-dir --session-id -H --header --port --host --base-path --auth --acp-transport --sandbox-id --teleport --max-turns --effort --autocompact --system-prompt --system-prompt-file --prompt-vars-file --tool-mode --settings --setting-sources --resume-session-at --rewind-files --plugin-dir --name --exec --prewarm-id --team-name --agent-name --agent-type --agent-color --leader-endpoint'.split(' '))
const optional=new Set('-d --debug -r --resume -w --worktree --sandbox --remote-control'.split(' '))
const flags=new Set('-d2e --debug-to-stderr --verbose -p --print --include-partial-messages -y --dangerously-skip-permissions -c --continue --tmux --tmux-classic --ide -v --version --strict-mcp-config --no-plugin-management --resume-create-missing --no-session-persistence --private-data-sticky --serve --open --brief --acp --a2a --sandbox-upload-dir --sandbox-new --sandbox-kill --fork-session --dry-run --replay-user-messages --bg --background --swarm --prewarm --prewarm-force --teammate-mode'.split(' '))
export function codebuddySystemPromptArgs(args,text){
 if(!text)return [...args]
 const result=[],prior=[]
 for(let i=0;i<args.length;i++){
  const arg=args[i]
  if(typeof arg!=='string')throw new Error('Invalid CodeBuddy argument')
  const eq=arg.indexOf('='),key=eq<0?arg:arg.slice(0,eq)
  if(['--agent','--agents','--multitask'].includes(key))throw new Error('Trusted append requires the original default CodeBuddy agent')
  if(arg==='--')throw new Error('Cannot append trusted instructions after CLI argument separator')
  if(key==='--append-system-prompt'){
   if(eq>=0)prior.push(arg.slice(eq+1))
   else {if(typeof args[i+1]!=='string')throw new Error('Invalid existing append-system-prompt');prior.push(args[++i])}
   continue
  }
  result.push(arg)
  if(required.has(key)){
   if(eq<0){if(typeof args[i+1]!=='string')throw new Error('Missing CodeBuddy option value');result.push(args[++i])}
  }else if(optional.has(key)){
   if(eq<0&&typeof args[i+1]==='string'&&!args[i+1].startsWith('-'))result.push(args[++i])
  }else if(!flags.has(key)&&arg.startsWith('-'))throw new Error('Unsupported CodeBuddy option syntax for trusted append')
 }
 if(prior.length>1)throw new Error('Ambiguous duplicate append-system-prompt options')
 return [...result,'--append-system-prompt',[...prior,text].filter(Boolean).join('\n\n')]
}
