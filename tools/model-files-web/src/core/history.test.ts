import assert from 'node:assert/strict'
import test from 'node:test'
import { addRepositoryHistory, parseRepositoryHistory } from './history.ts'

test('keeps ten recent canonical repositories with case-insensitive deduplication', () => {
  const history = Array.from({ length: 10 }, (_, index) => `owner/model-${index}`)
  assert.deepEqual(addRepositoryHistory(history, 'OWNER/model-4'), [
    'OWNER/model-4',
    'owner/model-0',
    'owner/model-1',
    'owner/model-2',
    'owner/model-3',
    'owner/model-5',
    'owner/model-6',
    'owner/model-7',
    'owner/model-8',
    'owner/model-9',
  ])
})

test('fails closed for malformed and invalid persisted history', () => {
  assert.deepEqual(parseRepositoryHistory('not json'), [])
  assert.deepEqual(parseRepositoryHistory(JSON.stringify(['owner/model', '../secret', 3])), ['owner/model'])
  assert.deepEqual(parseRepositoryHistory(JSON.stringify(['one/model', 'two/model'])), ['one/model', 'two/model'])
})
