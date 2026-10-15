import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const template = JSON.parse(readFileSync(new URL('../infra/main.json', import.meta.url), 'utf8'))
const core = template.resources.find(resource => resource.type === 'Microsoft.Resources/deployments').properties.template
const debugKey = core.resources.find(resource => resource.type === 'Microsoft.Web/sites/functions/keys')

test('the function-scoped debug key uses an ARM properties envelope', () => {
  assert.ok(debugKey, 'The classify function key must be deployed')
  assert.equal(Object.hasOwn(debugKey, 'value'), false, 'ARM rejects value at the resource root')
  assert.deepEqual(debugKey.properties, {
    name: 'debug-console',
    value: "[parameters('classifyFunctionKey')]"
  })
  assert.ok(debugKey.name.includes("'classify'"), 'The debug key must remain function-scoped')
})

test('the debug key remains secure and is only deployed with a code package', () => {
  assert.equal(template.parameters.classifyFunctionKey.type, 'securestring')
  assert.equal(core.parameters.classifyFunctionKey.type, 'securestring')
  assert.equal(debugKey.condition, "[not(empty(parameters('functionPackageUrl')))]")
})
