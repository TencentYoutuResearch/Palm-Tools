import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')

test('a Kode panel page reports its area once per change and releases it on unmount', () => {
  const requests = [], listeners = {}, frames = []
  let cleanup, observed, box = { left: 220, top: 28, width: 800, height: 600 }
  const scope = {
    h: (type, props) => ({ type, props }),
    useRef: () => ({ current: { getBoundingClientRect: () => box } }),
    useEffect: fn => { cleanup = fn() },
    requestAnimationFrame: fn => frames.push(fn),
    cancelAnimationFrame() {},
    ResizeObserver: class { constructor(fn) { observed = fn } observe() {} disconnect() { observed = null } },
    window: {
      kodeHost: { request: (action, params) => requests.push([action, params]) },
      addEventListener: (name, fn) => { listeners[name] = fn },
      removeEventListener: name => { delete listeners[name] },
    },
  }
  vm.createContext(scope)
  vm.runInContext(source.slice(source.indexOf('  const PANEL_GLYPH'), source.indexOf('  function KodeLeavePage(')), scope)
  const panel = { extension: 'kode.team', id: 'team', title: 'Team' }
  const page = scope.KodePanelPage({ panel })
  assert.equal(page.props.className, 'kode-panel-host')
  const flush = () => frames.splice(0).forEach(fn => fn())
  flush()
  observed()
  flush()
  // Objects come from another realm; compare their JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [['panel-show', { extension: 'kode.team', panel: 'team', rect: { x: 220, y: 28, width: 800, height: 600 } }]], 'an unchanged area is not reported again')
  box = { ...box, width: 640 }
  listeners.resize()
  flush()
  assert.equal(requests.at(-1)[1].rect.width, 640)
  cleanup()
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1))), ['panel-hide', { extension: 'kode.team', panel: 'team' }])
  assert.equal(listeners.resize, undefined)
  assert.equal(observed, null)
})
