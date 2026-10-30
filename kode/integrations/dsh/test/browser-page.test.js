import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const source=(await readFile(new URL('../packages/browser/page-source.js',import.meta.url),'utf8')).replace('export function','function')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('an expired sidebar lease is recreated on reload instead of remaining in an unrecoverable error state',async()=>{
 const calls=[],streams=[],nodes=[];let alive=false
 const element=()=>{const value={style:{},events:{},setAttribute(){},append(){},remove(){},focus(){},getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,width:800,height:900}),addEventListener(name,fn){this.events[name]=fn}};nodes.push(value);return value}
 const host=element(),scope=vm.createContext({crypto:{randomUUID},AbortSignal,URL,document:{getElementById:()=>host,createElement:element},ResizeObserver:class{observe(){}disconnect(){}},EventSource:class{constructor(url){this.url=url;streams.push(this)}close(){}},setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout,requestAnimationFrame:()=>0,cancelAnimationFrame(){},fetch:async(_url,request)=>{
  const input=JSON.parse(request.body);calls.push(input)
  if(input.action==='create'){alive=true;return{ok:true,status:200,json:async()=>({id:input.id,url:input.url,title:'Page',loading:false})}}
  if(input.action==='close'){alive=false;return{ok:true,status:200,json:async()=>({})}}
  return alive?{ok:true,status:200,json:async()=>({})}:{ok:false,status:404,json:async()=>({code:'BROWSER_TAB_GONE',error:'Browser tab expired'})}
 }})
 vm.runInContext(source,scope)
 const page=scope.createBrowserPage({persist(){},openRequested(){}});page.presentation.mount('viewport');page.frame.loadUrl({kind:'https',url:'https://example.com/',title:'Example'});await tick();await tick()
 assert.equal(calls.filter(c=>c.action==='create').length,1)
 alive=false;page.frame.reload();await tick();await tick();await tick()
 assert.equal(calls.filter(c=>c.action==='create').length,2)
 assert.equal(page.frame.getSnapshot().error,undefined);assert.equal(page.frame.getSnapshot().target.url,'https://example.com/')
 assert.ok(!calls.some(c=>['text','key','pointer'].includes(c.action)),'recovery must not replay user input')
 await page.frame.dispose()
})

test('pointer bursts retain the latest position and wheel distance without delaying click and key order',async()=>{
 const calls=[],nodes=[];let releaseMove,raf
 const element=()=>{const value={style:{},events:{},setAttribute(){},append(){},remove(){},focus(){},getBoundingClientRect:()=>({left:0,top:0,width:800,height:900}),addEventListener(name,fn){this.events[name]=fn}};nodes.push(value);return value}
 const host=element(),scope=vm.createContext({crypto:{randomUUID},AbortSignal,URL,document:{getElementById:()=>host,createElement:element},ResizeObserver:class{observe(){}disconnect(){}},EventSource:class{close(){}},setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout,requestAnimationFrame:fn=>{raf=fn;return 1},cancelAnimationFrame(){raf=undefined},fetch:async(_url,request)=>{
  const input=JSON.parse(request.body);calls.push(input)
  if(input.type==='mouseMoved'&&!releaseMove)await new Promise(resolve=>{releaseMove=resolve})
  return{ok:true,status:200,json:async()=>({id:input.id,url:'https://example.com/',loading:false})}
 }})
 vm.runInContext(source,scope)
 const page=scope.createBrowserPage({persist(){},openRequested(){}});page.presentation.mount('viewport');page.frame.loadUrl({kind:'https',url:'https://example.com/'});await tick();await tick()
 const surface=nodes.find(node=>node.events.pointerdown)
 const event=x=>({pointerId:1,pointerType:'mouse',clientX:x,clientY:90,button:0,buttons:0,detail:1,preventDefault(){}})
 surface.events.pointermove(event(1));raf();await tick()
 for(let x=2;x<=80;x++){surface.events.pointermove(event(x));raf()}
 for(let n=0;n<30;n++)surface.events.wheel({...event(80),deltaX:0,deltaY:10})
 surface.events.pointerdown({...event(80),buttons:1});surface.events.pointerup(event(80))
 const keyEvent={key:'a',code:'KeyA',keyCode:65,preventDefault(){},stopPropagation(){}}
 surface.events.keydown({...keyEvent,type:'keydown'});surface.events.keyup({...keyEvent,type:'keyup'})
 releaseMove();for(let i=0;i<12;i++)await tick()
 const sent=calls.filter(c=>c.action==='pointer')
 assert.equal(sent.filter(c=>c.type==='mouseMoved').length,2,'stale hover positions must not accumulate behind an in-flight request')
 assert.equal(sent.filter(c=>c.type==='mouseMoved').at(-1).x,80)
 assert.equal(sent.filter(c=>c.type==='mouseWheel').reduce((sum,c)=>sum+c.deltaY,0),300)
 assert.deepEqual(sent.slice(-2).map(c=>c.type),['mousePressed','mouseReleased'])
 assert.ok(sent.length<=5,`expected bounded pointer traffic, got ${sent.length}`)
 assert.deepEqual(calls.filter(c=>['pointer','key'].includes(c.action)).slice(-4).map(c=>c.type),['mousePressed','mouseReleased','keyDown','keyUp'])
 await page.frame.dispose()
})
