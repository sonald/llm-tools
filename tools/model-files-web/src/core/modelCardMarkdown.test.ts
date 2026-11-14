import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelCardImageWidth, modelCardRenderable } from './modelCardMarkdown.ts'

describe('modelCardRenderable', () => {
  it('matches native testPreparesModelCardMarkdownWithoutDamagingCode', () => {
    const source = [
      '---',
      'license: apache-2.0',
      '---',
      '# Model',
      '<img src="https://example.com/model.png" style="display: block; width: 30%;">',
      '<p align="center"><a href="https://example.com">Docs</a></p>',
      '<https://example.com/model-card>',
      '```html',
      '<strong>keep source</strong>',
      '```',
    ].join('\n')
    assert.equal(modelCardRenderable(source), [
      '# Model',
      '![](https://example.com/model.png#model-files-width=30pct)',
      '[Docs](https://example.com)',
      '<https://example.com/model-card>',
      '```html',
      '<strong>keep source</strong>',
      '```',
    ].join('\n'))
  })

  it('strips front matter only when it opens the file and closes', () => {
    assert.equal(modelCardRenderable('  ---  \na: 1\n---\nbody'), 'body')
    assert.equal(modelCardRenderable('---\na: 1\nbody'), '---\na: 1\nbody')
    assert.equal(modelCardRenderable('# T\n---\nx\n---'), '# T\n---\nx\n---')
    // Swift splits on the Character "\n"; "\r\n" is a single Character there, so CRLF front matter stays.
    assert.equal(modelCardRenderable('---\r\na: 1\r\n---\r\nbody'), '---\r\na: 1\r\n---\r\nbody')
  })

  it('converts img attributes like native, keeping width as a URL marker', () => {
    assert.equal(modelCardRenderable(`<img alt='Logo' src=logo.png width="120">`), '![Logo](logo.png#model-files-width=120px)')
    assert.equal(modelCardRenderable('<img src="a.png#x" width="50%"/>'), '![](a.png#x&model-files-width=50pct)')
    assert.equal(modelCardRenderable('<img src="a.png" width="auto">'), '![](a.png)')
    assert.equal(modelCardRenderable('<IMG SRC="a.png" STYLE="max-width: 64px">'), '![](a.png#model-files-width=64px)')
    // No src: the tag is stripped like any other.
    assert.equal(modelCardRenderable('x<img alt="none">y'), 'xy')
    assert.equal(modelCardRenderable('<img src="a.png"><img src="b.png">'), '![](a.png)![](b.png)')
  })

  it('converts links and breaks, strips other tags, and leaves fenced code alone', () => {
    assert.equal(modelCardRenderable('<a href="https://x.dev" target="_blank"><b>Site</b></a>'), '[Site](https://x.dev)')
    assert.equal(modelCardRenderable('a<br>b<BR/>c'), 'a  b  c')
    assert.equal(modelCardRenderable('<div align="center"><script>alert(1)</script></div>'), 'alert(1)')
    assert.equal(modelCardRenderable('~~~\n<b>x</b>\n```\n<b>y</b>\n~~~\n<b>z</b>'), '~~~\n<b>x</b>\n```\n<b>y</b>\n~~~\nz')
    assert.equal(modelCardRenderable('<img src="x" onerror="alert(1)">'), '![](x)')
  })

  it('never produces raw HTML for script or event-handler input', () => {
    const output = modelCardRenderable('<p onclick="x()">hi</p><iframe src="https://e.vil"></iframe><svg onload="x()"></svg>')
    assert.equal(output, 'hi')
  })
})

describe('modelCardImageWidth', () => {
  it('reads the width marker as native maximumWidth does', () => {
    assert.equal(modelCardImageWidth('https://e.com/a.png#model-files-width=30pct'), 276)
    assert.equal(modelCardImageWidth('https://e.com/a.png#x&model-files-width=120px'), 120)
    assert.equal(modelCardImageWidth('https://e.com/a.png#model-files-width=5000px'), 920)
    assert.equal(modelCardImageWidth('https://e.com/a.png#model-files-width=0.5pct'), 9.2)
    assert.equal(modelCardImageWidth('https://e.com/a.png#model-files-width=200pct'), 920)
    assert.equal(modelCardImageWidth('https://e.com/a.png'), null)
    assert.equal(modelCardImageWidth('https://e.com/a.png#model-files-width=wide'), null)
  })
})
