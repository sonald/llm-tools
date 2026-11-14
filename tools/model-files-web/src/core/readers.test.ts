import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeStrictText,
  defaultTextFindOptions,
  forEachTextMatch,
  inspectionPerspectives,
  jsonSummary,
  jsonSummaryKind,
  repositoryMarkdownUrl,
  navigateTextMatches,
  perspectiveLabel,
  textLineAtOffset,
  sourceChunks,
  validatePdfData,
  vocabEntries,
  type TextFindOptions,
} from './readers.ts'
import { imageMimeType, isImagePath, type RepositorySnapshot } from './huggingface.ts'

const snapshot: RepositorySnapshot = {
  source: 'huggingface',
  modelId: 'owner/model',
  revision: '0123456789abcdef0123456789abcdef01234567',
  files: [],
}

test('summaries follow native readers, keeping exact numbers and inline collections', () => {
  const config = jsonSummary('config', '{"architectures":["Qwen3ForCausalLM"],"model_type":"qwen3","torch_dtype":"bfloat16",'
    + '"num_hidden_layers":28,"hidden_size":1024,"vocab_size":151936,"rope_theta":1000000,"head_dim":128,"big":1e30}')
  assert.equal(config.title, 'Qwen3ForCausalLM')
  assert.equal(config.subtitle, 'qwen3 · bfloat16 · 28 layers')
  assert.deepEqual(config.groups.map(group => [group.title, group.rows]), [
    ['模型规模', [['隐藏层维度（hidden_size）', '1024'], ['词表大小（vocab_size）', '151936']]],
    ['Attention', [['头维度（head_dim）', '128']]],
    ['上下文', [['RoPE θ（rope_theta）', '1000000']]],
  ])
  assert.equal(jsonSummary('config', '{"model_type":"llama"}').title, 'llama')
  assert.equal(jsonSummary('config', '{"broken":').title, '模型配置')

  const generation = jsonSummary('generation', '{"eos_token_id":[151645,151643],"top_k":20,"bos_token_id":1,"max_length":9}')
  assert.deepEqual(generation.groups.map(group => group.rows), [
    [['Top K', '20']],
    [['EOS token', '[   151645,   151643 ]']],
  ])

  const tokenizer = jsonSummary('tokenizerConfig', '{"tokenizer_class":"Qwen2Tokenizer","padding_side":"right",'
    + '"unk_token":null,"eos_token":{"content":"</s>","lstrip":false}}')
  assert.equal(tokenizer.title, 'Qwen2Tokenizer')
  assert.deepEqual(tokenizer.groups[0].rows, [
    ['Padding side', 'right'], ['EOS token', '{   "content" : "<\\/s>",   "lstrip" : false }'], ['UNK token', 'null'],
  ])

  const index = jsonSummary('weightIndex', '{"metadata":{"total_size":1503300328},'
    + '"weight_map":{"b":"two.safetensors","a":"one.safetensors","c":"one.safetensors"}}')
  assert.deepEqual(index.groups[0].rows, [['参数张量', '3'], ['分片数量', '2'], ['权重总大小', '1.5 GB']])
  assert.deepEqual(index.mappings, [['a', 'one.safetensors'], ['b', 'two.safetensors'], ['c', 'one.safetensors']])
  assert.equal(jsonSummaryKind('nested/config.json', 'configuration'), 'config')
  assert.equal(jsonSummaryKind('model.safetensors.index.json', 'weightMetadata'), 'weightIndex')
  assert.equal(jsonSummaryKind('metadata.json', 'other'), null)
})

test('vocab entries keep integer IDs, search token or ID and sort by ID', () => {
  const vocab = { beta: 2, Alpha: 10, gamma: 1, bad: 'x' }
  assert.deepEqual(vocabEntries(vocab, ''), [['gamma', 1], ['beta', 2], ['Alpha', 10]])
  assert.deepEqual(vocabEntries(vocab, 'al'), [['Alpha', 10]])
  assert.deepEqual(vocabEntries(vocab, '1'), [['gamma', 1], ['Alpha', 10]])
})

test('source chunks cut at line starts by count or size and keep long lines whole', () => {
  const content = 'a\nb\r\nc\rd\ne'
  assert.deepEqual(sourceChunks(content, 2), [
    { start: 0, end: 5, firstLine: 1, lineCount: 2 },
    { start: 5, end: 9, firstLine: 3, lineCount: 2 },
    { start: 9, end: 10, firstLine: 5, lineCount: 1 },
  ])
  // A long line is cut into pieces that continue line 1; the last piece also holds line 2.
  assert.deepEqual(sourceChunks('x'.repeat(10) + '\n' + 'y', 400, 4), [
    { start: 0, end: 4, firstLine: 1, lineCount: 1 },
    { start: 4, end: 8, firstLine: 1, lineCount: 1 },
    { start: 8, end: 12, firstLine: 1, lineCount: 2 },
  ])
  assert.deepEqual(sourceChunks('ab\nc' + 'x'.repeat(5), 400, 4).map(chunk => [chunk.start, chunk.end, chunk.firstLine, chunk.lineCount]), [
    [0, 3, 1, 1], [3, 7, 2, 1], [7, 9, 2, 1],
  ])
  assert.deepEqual(sourceChunks('abc😀d', 400, 4).map(chunk => [chunk.start, chunk.end]), [[0, 5], [5, 6]])
  assert.deepEqual(sourceChunks('abc\r\nzz', 400, 4).map(chunk => [chunk.start, chunk.end, chunk.firstLine, chunk.lineCount]), [
    [0, 5, 1, 1], [5, 7, 2, 1],
  ])
  assert.deepEqual(sourceChunks(''), [{ start: 0, end: 0, firstLine: 1, lineCount: 1 }])
  assert.deepEqual(sourceChunks('a\n'), [{ start: 0, end: 2, firstLine: 1, lineCount: 1 }])
})

test('finds literal text matches without retaining a match array', () => {
  const content = 'Aa aa .a 中文😀中文'
  const empty = { total: 0, current: 0, start: 0, end: 0 }
  assert.deepEqual(navigateTextMatches(content, '', 'initial'), empty)
  assert.deepEqual(navigateTextMatches(content, 'zz', 'initial'), empty)
  assert.deepEqual(navigateTextMatches(content, '.', 'initial'), {
    total: 1, current: 1, start: 6, end: 7,
  })
  assert.deepEqual(navigateTextMatches(content, 'a', 'next', 2), {
    total: 5, current: 3, start: 3, end: 4,
  })
  assert.deepEqual(navigateTextMatches(content, 'a', 'previous', 1), {
    total: 5, current: 5, start: 7, end: 8,
  })
  assert.deepEqual(navigateTextMatches(content, 'a', 'next', 5), {
    total: 5, current: 1, start: 0, end: 1,
  })
})

test('matches Chinese and emoji by UTF-16 offsets', () => {
  const content = '中文😀中文'
  const lineContent = 'one\n中文\r\n😀\n'
  assert.deepEqual(navigateTextMatches(content, '文', 'initial'), {
    total: 2, current: 1, start: 1, end: 2,
  })
  assert.deepEqual(navigateTextMatches(content, '😀中', 'next'), {
    total: 1, current: 1, start: 2, end: 5,
  })
  const expanding = 'İNEEDLE'
  assert.deepEqual(navigateTextMatches(expanding, 'NEEDLE', 'initial'), {
    total: 1, current: 1, start: 1, end: 7,
  })
  assert.equal(textLineAtOffset(content, 0), 1)
  assert.equal(textLineAtOffset(content, content.length), 1)
  assert.equal(textLineAtOffset(lineContent, lineContent.indexOf('😀')), 3)
  assert.equal(textLineAtOffset('one\nsecond\n', 10), 2)
})

test('visits callback matches with UTF-16 start and end offsets', () => {
  const content = '中文😀中文'
  const starts: number[] = []
  forEachTextMatch(content, '中文', start => starts.push(start))
  assert.deepEqual(starts, [0, 4])
  const lastStart = starts.at(-1)!
  assert.equal(lastStart + '中文'.length, 6)
})

test('pins repository-relative Markdown URLs and rejects active protocols', () => {
  assert.equal(
    repositoryMarkdownUrl(snapshot, 'docs/README.md', '../config.json#model', 'href'),
    `https://huggingface.co/owner/model/blob/${snapshot.revision}/config.json#model`,
  )
  assert.equal(
    repositoryMarkdownUrl(snapshot, 'docs/README.md', './image.png', 'src'),
    `https://huggingface.co/owner/model/resolve/${snapshot.revision}/docs/image.png`,
  )
  assert.equal(repositoryMarkdownUrl(snapshot, 'README.md', 'javascript:alert(1)', 'href'), null)
})

test('decodes fatal UTF-8 text and rejects invalid sequences', () => {
  assert.equal(decodeStrictText(new TextEncoder().encode('中文').buffer), '中文')
  assert.throws(() => decodeStrictText(Uint8Array.from([0xff]).buffer), /UTF-8/)
})

test('rejects NUL bytes in strict text', () => {
  assert.throws(() => decodeStrictText(Uint8Array.from([97, 0]).buffer), /NUL/)
})

test('validates PDF data by its first five signature bytes', () => {
  validatePdfData(new TextEncoder().encode('%PDF-1.7').buffer)
  assert.throws(() => validatePdfData(new TextEncoder().encode('not a pdf').buffer), /PDF/)
})

test('identifies image files and maps their mime types', () => {
  assert.equal(isImagePath('assets/diagram.svg'), true)
  assert.equal(isImagePath('images/logo.png'), true)
  assert.equal(isImagePath('photo.JPEG'), true)
  assert.equal(isImagePath('banner.webp'), true)
  assert.equal(isImagePath('anim.gif'), true)
  assert.equal(isImagePath('icon.ico'), true)
  assert.equal(isImagePath('bitmap.bmp'), true)
  assert.equal(isImagePath('photo.avif'), true)
  assert.equal(isImagePath('config.json'), false)
  assert.equal(isImagePath('model.safetensors'), false)
  assert.equal(isImagePath('doc.pdf'), false)

  assert.equal(imageMimeType('diagram.svg'), 'image/svg+xml')
  assert.equal(imageMimeType('logo.png'), 'image/png')
  assert.equal(imageMimeType('photo.jpg'), 'image/jpeg')
  assert.equal(imageMimeType('scan.TIF'), 'image/tiff')
  assert.equal(isImagePath('scan.tiff'), true)
  assert.equal(imageMimeType('photo.jpeg'), 'image/jpeg')
  assert.equal(imageMimeType('banner.webp'), 'image/webp')
  assert.equal(imageMimeType('anim.gif'), 'image/gif')
  assert.equal(imageMimeType('icon.ico'), 'image/x-icon')
  assert.equal(imageMimeType('bitmap.bmp'), 'image/bmp')
  assert.equal(imageMimeType('photo.avif'), 'image/avif')
  assert.equal(imageMimeType('other.xyz'), 'application/octet-stream')
})

test('offers the native perspectives for each document kind', () => {
  assert.deepEqual(inspectionPerspectives('generic', 'config.json'), ['overview', 'fields', 'raw'])
  assert.deepEqual(inspectionPerspectives('generic', 'nested/tokenizer.json'), ['overview', 'fields', 'raw', 'playground'])
  assert.deepEqual(inspectionPerspectives('generic', 'tokenizer.model'), ['playground'])
  assert.deepEqual(inspectionPerspectives('safetensors', 'model.safetensors'), ['overview', 'metadata', 'tensors'])
  assert.deepEqual(inspectionPerspectives('imatrix', 'imatrix.dat'), ['overview', 'entries'])
  assert.deepEqual(inspectionPerspectives('jinja', 'chat_template.jinja'), ['overview', 'source', 'playground'])
  assert.deepEqual(inspectionPerspectives('image', 'logo.svg'), ['overview', 'source'])
  assert.deepEqual(inspectionPerspectives('image', 'logo.png'), ['overview'])
  assert.deepEqual(inspectionPerspectives('pdf', 'paper.pdf'), ['overview'])
  assert.equal(perspectiveLabel('overview', 'generic', 'README.md'), '渲染')
  assert.equal(perspectiveLabel('overview', 'image', 'logo.svg'), '渲染')
  assert.equal(perspectiveLabel('overview', 'image', 'logo.png'), '预览')
  assert.equal(perspectiveLabel('overview', 'pdf', 'paper.pdf'), '预览')
  assert.equal(perspectiveLabel('overview', 'generic', 'config.json'), '概览')
  assert.equal(perspectiveLabel('raw', 'generic', 'config.json'), '原文')
})

test('find bar options: ignore case, wrap around, contains / starts with / full word (NSTextFinder)', () => {
  // The native find bar shows 4 for "alpha" on this text with its defaults (contains, ignore case).
  const content = 'alpha beta alphabet\nAlpha gamma alp\nbeta alpha'
  const count = (query: string, options: Partial<TextFindOptions> = {}, text = content) => {
    let total = 0
    forEachTextMatch(text, query, () => { total += 1 }, { ...defaultTextFindOptions, ...options })
    return total
  }
  assert.equal(count('alpha'), 4)
  assert.equal(count('alpha', { ignoreCase: false }), 3)
  assert.equal(count('alp'), 5)
  assert.equal(count('alp', { matchType: 'startsWith' }), 5)
  assert.equal(count('alp', { matchType: 'fullWord' }), 1)
  assert.equal(count('pha'), 4)
  assert.equal(count('pha', { matchType: 'startsWith' }), 0)
  assert.equal(count('alpha', { matchType: 'fullWord' }), 3)
  assert.equal(count('alpha beta', { matchType: 'fullWord' }), 1)
  assert.equal(count('snake', { matchType: 'fullWord' }, 'snake_case snake'), 1)

  const fixed = { ...defaultTextFindOptions, wrapAround: false }
  assert.equal(navigateTextMatches(content, 'alpha', 'next', 4, fixed).current, 4)
  assert.equal(navigateTextMatches(content, 'alpha', 'previous', 1, fixed).current, 1)
  assert.equal(navigateTextMatches(content, 'alpha', 'next', 4).current, 1)
  assert.equal(navigateTextMatches(content, 'alpha', 'previous', 1).current, 4)
})
