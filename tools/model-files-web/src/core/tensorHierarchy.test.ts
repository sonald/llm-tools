import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import type { TensorSummary } from './inspectors.ts'
import {
  autoExpandMatchingPaths,
  buildTensorHierarchy,
  filterTensorSummaries,
  flattenTensorHierarchy,
} from './tensorHierarchy.ts'

test('builds common prefixes with full paths, relative labels, and descendant counts', () => {
  const roots = buildTensorHierarchy([
    tensor('model.layers.0.weight'),
    tensor('model.layers.1.weight'),
    tensor('model.embed.weight'),
  ])

  assert.equal(roots.length, 1)
  const model = roots[0]
  assert.equal(model.id, 'group:model')
  assert.equal(model.path, 'model')
  assert.equal(model.label, 'model')
  assert.equal(model.tensor, undefined)
  assert.equal(model.descendantCount, 3)

  const embed = model.children.find(node => node.path === 'model.embed')
  assert.ok(embed)
  assert.equal(embed.label, 'embed')
  assert.equal(embed.descendantCount, 1)
  const leaf = embed.children[0]
  assert.equal(leaf.id, 'tensor:model.embed.weight')
  assert.equal(leaf.path, 'model.embed.weight')
  assert.equal(leaf.label, 'weight')
  assert.equal(leaf.tensor?.name, 'model.embed.weight')
})

test('keeps numeric segments as groups and sorts them naturally', () => {
  const roots = buildTensorHierarchy([
    tensor('model.layers.10.weight'),
    tensor('model.layers.2.weight'),
  ])
  const layers = roots[0].children.find(node => node.path === 'model.layers')
  assert.ok(layers)
  assert.deepEqual(layers.children.map(node => ({ id: node.id, label: node.label })), [
    { id: 'group:model.layers.2', label: '2' },
    { id: 'group:model.layers.10', label: '10' },
  ])
  assert.equal(layers.children[0].descendantCount, 1)
})

test('filters by trimmed name or dtype and returns all tensors for blank queries', () => {
  const tensors = [
    tensor('model.layers.0.weight', 'BF16'),
    tensor('model.layers.1.bias', 'F32'),
  ] as const

  assert.deepEqual(filterTensorSummaries(tensors, '  LAYERS.1  ').map(item => item.name), [
    'model.layers.1.bias',
  ])
  assert.deepEqual(filterTensorSummaries(tensors, '  bf16\n').map(item => item.name), [
    'model.layers.0.weight',
  ])
  assert.deepEqual(filterTensorSummaries(tensors, '').map(item => item.name), tensors.map(item => item.name))
  assert.deepEqual(filterTensorSummaries(tensors, ' \t\n ').map(item => item.name), tensors.map(item => item.name))
  assert.deepEqual(filterTensorSummaries(tensors, 'missing'), [])
})

test('preserves a tensor that is also a group prefix with distinct row IDs', () => {
  const roots = buildTensorHierarchy([
    tensor('foo'),
    tensor('foo.weight'),
  ])
  assert.equal(roots.length, 1)
  const foo = roots[0]
  assert.equal(foo.id, 'group:foo')
  assert.equal(foo.tensor?.name, 'foo')
  assert.equal(foo.descendantCount, 2)
  assert.equal(foo.children[0].id, 'tensor:foo.weight')

  const rows = flattenTensorHierarchy(roots, new Set([foo.id]))
  assert.deepEqual(rows.map(row => ({ id: row.id, depth: row.depth })), [
    { id: 'group:foo', depth: 0 },
    { id: 'tensor:foo', depth: 1 },
    { id: 'tensor:foo.weight', depth: 1 },
  ])
  assert.notEqual(rows[0].id, rows[1].id)
  assert.equal(rows[1].tensor?.name, 'foo')
})

test('ignores empty segments and falls back to a non-empty dotted name', () => {
  const roots = buildTensorHierarchy([
    tensor('.model..layers...weight'),
    tensor('...'),
  ])
  assert.deepEqual(roots.map(node => node.path), ['...','model'])
  const model = roots.find(node => node.path === 'model')
  assert.ok(model)
  assert.equal(model.children[0].path, 'model.layers')
  assert.equal(model.children[0].children[0].path, 'model.layers.weight')
  assert.equal(model.children[0].children[0].label, 'weight')
  assert.ok(roots.every(node => node.label.length > 0))
})

test('auto-expands only group ancestors of matching name or dtype paths', () => {
  const roots = buildTensorHierarchy([
    tensor('model.layers.10.weight', 'BF16'),
    tensor('model.layers.2.weight', 'BF16'),
    tensor('model.head.bias', 'F32'),
  ])

  assert.deepEqual(
    [...autoExpandMatchingPaths(roots, 'layers.10')],
    ['group:model', 'group:model.layers', 'group:model.layers.10'],
  )
  assert.deepEqual(
    [...autoExpandMatchingPaths(roots, ' F32 ')],
    ['group:model', 'group:model.head'],
  )
  assert.deepEqual([...autoExpandMatchingPaths(roots, '   ')], [])
})

test('flattens only descendants of expanded ancestors and includes depth', () => {
  const roots = buildTensorHierarchy([
    tensor('model.layers.0.weight'),
    tensor('model.layers.1.weight'),
    tensor('model.head.bias'),
  ])
  const modelID = roots[0].id
  const layersID = roots[0].children.find(node => node.path === 'model.layers')?.id
  assert.ok(layersID)

  assert.deepEqual(flattenTensorHierarchy(roots, new Set([layersID])).map(row => row.id), [
    modelID,
  ])
  assert.deepEqual(
    flattenTensorHierarchy(roots, new Set([modelID])).map(row => ({ id: row.id, depth: row.depth })),
    [
      { id: modelID, depth: 0 },
      { id: 'group:model.head', depth: 1 },
      { id: layersID, depth: 1 },
    ],
  )
  assert.deepEqual(
    flattenTensorHierarchy(roots, new Set([modelID, layersID])).map(row => ({ id: row.id, depth: row.depth })),
    [
      { id: modelID, depth: 0 },
      { id: 'group:model.head', depth: 1 },
      { id: layersID, depth: 1 },
      { id: 'group:model.layers.0', depth: 2 },
      { id: 'group:model.layers.1', depth: 2 },
    ],
  )

  const layerIDs = new Set(['group:model.layers.0', 'group:model.layers.1'])
  assert.deepEqual(
    flattenTensorHierarchy(roots, new Set([modelID, layersID, ...layerIDs])).map(row => ({ id: row.id, depth: row.depth })),
    [
      { id: modelID, depth: 0 },
      { id: 'group:model.head', depth: 1 },
      { id: layersID, depth: 1 },
      { id: 'group:model.layers.0', depth: 2 },
      { id: 'tensor:model.layers.0.weight', depth: 3 },
      { id: 'group:model.layers.1', depth: 2 },
      { id: 'tensor:model.layers.1.weight', depth: 3 },
    ],
  )
})

test('builds 10,000 tensors without dropping leaves in under one second', () => {
  const tensors = Array.from({ length: 10_000 }, (_, index) => tensor(`model.layers.${index}.weight`))
  const startedAt = performance.now()
  const roots = buildTensorHierarchy(tensors)
  const elapsedMilliseconds = performance.now() - startedAt

  assert.equal(roots.length, 1)
  assert.equal(roots[0].descendantCount, tensors.length)
  let leafCount = 0
  const visit = (node: (typeof roots)[number]) => {
    if (node.tensor !== undefined) leafCount += 1
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  assert.equal(leafCount, tensors.length)
  assert.ok(elapsedMilliseconds < 1_000, `buildTensorHierarchy took ${elapsedMilliseconds} ms`)
})

function tensor(name: string, dtype = 'BF16'): TensorSummary {
  return {
    name,
    dtype,
    shape: [1],
    parameters: 1n,
    bytes: 2n,
    dataStart: 0n,
    dataEnd: 2n,
  }
}
