import assert from 'node:assert/strict'
import test from 'node:test'
import { Template } from '@huggingface/jinja'

test('renders chat messages, tools, variables, and a generation prompt exactly', () => {
  const source = `{%- for message in messages %}{{ message.role }}={{ message.content }};{%- endfor %}
{{- tools | tojson }};thinking={{ enable_thinking }}
{%- if add_generation_prompt %};assistant={% endif -%}`
  const output = new Template(source).render({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
    enable_thinking: false,
    add_generation_prompt: true,
  })

  assert.equal(
    output,
    'user=hello;[{"type": "function", "function": {"name": "search", "parameters": {"type": "object"}}}];thinking=false;assistant=',
  )
})

test('supports the namespace, reverse iteration, and type tests used by Qwen templates', () => {
  const source = `{%- set ns = namespace(last=messages|length - 1) -%}
{%- for message in messages[::-1] -%}
{{- loop.index0 }}={{ message.content if message.content is string else '' }}@{{ ns.last }};
{%- endfor -%}`

  assert.equal(
    new Template(source).render({ messages: [{ content: 'first' }, { content: ['second'] }] }),
    '0=@1;1=first@1;',
  )
})

test('rejects template includes instead of fetching external content', () => {
  assert.throws(
    () => new Template('{% include "https://example.com/template.jinja" %}'),
    /Unknown statement type: include/,
  )
})
