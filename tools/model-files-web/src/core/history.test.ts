import assert from 'node:assert/strict'
import test from 'node:test'
import { addRepositoryHistory, parseRepositoryHistory } from './history.ts'

test('keeps every recent canonical repository with case-insensitive deduplication', () => {
  const history = Array.from({ length: 12 }, (_, index) => `owner/model-${index}`)
  const updated = addRepositoryHistory(history, 'OWNER/model-4')
  assert.equal(updated.length, 12)
  assert.deepEqual(updated.slice(0, 3), ['OWNER/model-4', 'owner/model-0', 'owner/model-1'])
  assert.equal(addRepositoryHistory(updated, 'new/model').length, 13)
  assert.equal(parseRepositoryHistory(JSON.stringify(updated)).length, 12)
})

test('fails closed for malformed and invalid persisted history', () => {
  assert.deepEqual(parseRepositoryHistory('not json'), [])
  assert.deepEqual(parseRepositoryHistory(JSON.stringify(['owner/model', '../secret', 3])), ['owner/model'])
  assert.deepEqual(parseRepositoryHistory(JSON.stringify(['one/model', 'two/model'])), ['one/model', 'two/model'])
})
