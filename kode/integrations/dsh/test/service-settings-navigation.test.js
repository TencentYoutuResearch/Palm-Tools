import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
function fixture(open = () => {}) {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const scope = {
    h, React: { Fragment: 'fragment', useRef: value => ({ current: value }) },
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect(fn) { fn() },
    transport: { current: 'local' }, requestedServiceHost: undefined, requestedSettingsSection: undefined,
    window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }, CustomEvent: class {}, requestAnimationFrame() {},
    AgentSettingsBody: 'agents', PersonalizationSettings: 'personalization',
    useProjectHosts: () => ({ data: { current: 'local', hosts: [{ id: 'local', name: 'This computer' }, { id: 'worker', name: 'Worker' }] } }),
    useIntegrationSettings: () => ({ data: null, busy: false, error: 'Missing API', recoveryNeeded: true }),
    Button: 'button', Failure: 'failure', SelectField: 'select', RemoteComputerIcon: 'icon', IconPlusOutlineRegular: 'plus',
    RemoteHostForm: 'form', ServiceRecovery: 'recovery',
  }
  vm.createContext(scope)
  vm.runInContext(source.slice(source.indexOf('  function openSettings('), source.indexOf('  let requestedProfile')), scope)
  vm.runInContext(source.slice(source.indexOf('  function ServiceRecoveryLink('), source.indexOf('  function MobilePairingInvite(')), scope)
  vm.runInContext(source.slice(source.indexOf('  function SshSettings('), source.indexOf('  let workspaceSnapshot')), scope)
  vm.runInContext(source.slice(source.indexOf('  const settingsSections ='), source.indexOf('  function AgentSettingsBody')), scope)
  const slots = { entries: () => [{ store: { create: () => ({ actions: { openSection: open } }) } }] }
  return { scope, slots }
}
const nodes = tree => [tree, ...tree.children.filter(child => child && typeof child === 'object').flatMap(nodes)]

test('service recovery navigation selects the failing Host without switching the workspace', () => {
  const opened = [], { scope, slots } = fixture(id => opened.push(id))
  nodes(scope.ServiceRecoveryLink({ host: 'worker', slots })).find(node => node.type === 'button').props.onClick()
  assert.deepEqual(opened, ['kode'])
  const page = scope.KodeSettings({ slots })
  assert.equal(nodes(page).find(node => node.type === 'select').props.value, 'worker')
  const service = nodes(page).find(node => node.type === scope.SshSettings)
  assert.equal(nodes(scope.SshSettings(service.props)).find(node => node.type === scope.HostServiceStatus).props.host, 'worker')
  for (const type of ['agents', scope.IntegrationSettingsBody, scope.MobileSettingsBody]) {
    const body = nodes(page).find(node => node.type === type)
    assert.equal(body.props.host ?? body.props.settingsHost, 'worker')
  }
  assert.equal(scope.transport.current, 'local')
  assert.equal(scope.requestedServiceHost, undefined, 'consume the navigation target once')
  assert.equal(nodes(scope.KodeSettings({ slots })).find(node => node.type === 'select').props.value, 'local')
})

test('failed navigation cannot leave a stale service Host for a later settings visit', () => {
  const { scope, slots } = fixture(() => { throw new Error('Settings not ready') })
  nodes(scope.ServiceRecoveryLink({ host: 'worker', slots })).find(node => node.type === 'button').props.onClick()
  assert.equal(scope.requestedServiceHost, undefined)
})

test('integration and mobile errors link to service management instead of offering restart actions', () => {
  const { scope, slots } = fixture()
  for (const component of [scope.IntegrationSettingsBody, scope.MobileSettingsBody]) {
    const tree = nodes(component({ host: 'worker', slots }))
    assert.equal(tree.filter(node => node.type === scope.ServiceRecoveryLink).length, 1)
    assert.equal(tree.find(node => node.type === scope.ServiceRecoveryLink).props.host, 'worker')
    assert.equal(tree.some(node => node.type === 'recovery'), false)
  }
  assert.equal(nodes(scope.HostServiceStatus({ host: 'local' })).find(node => node.type === 'recovery').props.host, 'local')
})
