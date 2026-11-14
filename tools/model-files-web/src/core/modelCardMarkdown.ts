// Native ModelCardMarkdown (MarkdownReaderView.swift): YAML front matter is dropped, and outside code fences
// inline <img>, <a> and <br> become Markdown while every other tag is stripped. Raw HTML is never rendered.

const widthKey = 'model-files-width='

export function modelCardRenderable(source: string): string {
  // ponytail: Swift splits on the Character "\n", and "\r\n" is one Character there, so CRLF files are one
  // "line" natively (front matter kept, fences not seen). Mirrored on purpose; fix both sides together.
  const lines = source.split(/(?<!\r)\n/)
  let content = lines
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end !== -1) content = lines.slice(end + 1)
  }

  let fence: string | null = null
  return content.map(line => {
    const marker = fenceMarker(line)
    if (marker !== null) {
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      return line
    }
    if (fence !== null) return line
    return replacingImages(line)
      .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<br\s*\/?>/gi, '  ')
      .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\s*\/?>/gi, '')
  }).join('\n')
}

// Native ModelCardImageLoader.maximumWidth: the width marker on the image URL, in points of the 920-wide column.
export function modelCardImageWidth(url: string): number | null {
  const hash = url.indexOf('#')
  if (hash === -1) return null
  const marker = url.slice(hash + 1).split('&').find(part => part.startsWith(widthKey))
  if (marker === undefined) return null
  const value = marker.split('=').slice(1).join('=')
  if (value.endsWith('pct')) {
    const percent = swiftDouble(value.slice(0, -3))
    return percent === null ? null : 920 * Math.min(Math.max(percent, 1), 100) / 100
  }
  if (value.endsWith('px')) {
    const points = swiftDouble(value.slice(0, -2))
    return points === null ? null : Math.min(Math.max(points, 1), 920)
  }
  return null
}

function replacingImages(line: string): string {
  let result = line
  const matches = [...line.matchAll(/<img\b([^>]*)>/gi)]
  for (const match of matches.reverse()) {
    const attributes = match[1]
    const source = attribute('src', attributes)
    if (source === null) continue
    const alt = attribute('alt', attributes) ?? ''
    const width = imageWidth(attributes)
    const url = source + (width === null ? '' : (source.includes('#') ? '&' : '#') + widthKey + width)
    result = result.slice(0, match.index) + `![${alt}](${url})` + result.slice(match.index + match[0].length)
  }
  return result
}

function attribute(name: string, text: string): string | null {
  for (const pattern of [`\\b${name}\\s*=\\s*"([^"]*)"`, `\\b${name}\\s*=\\s*'([^']*)'`, `\\b${name}\\s*=\\s*([^\\s>]+)`]) {
    const value = new RegExp(pattern, 'i').exec(text)?.[1]
    if (value !== undefined) return value
  }
  return null
}

function imageWidth(attributes: string): string | null {
  const style = attribute('style', attributes)
  const fromStyle = style === null ? null : /\bwidth\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(%|px)/i.exec(style)
  const width = attribute('width', attributes)
  const value = fromStyle ?? (width === null ? null : /^\s*([0-9]+(?:\.[0-9]+)?)\s*(%|px)?\s*$/i.exec(width))
  if (value === null) return null
  return value[1] + ((value[2] ?? 'px') === '%' ? 'pct' : 'px')
}

function fenceMarker(line: string): string | null {
  const trimmed = line.replace(/^\s+/, '')
  const marker = trimmed[0]
  if (marker !== '`' && marker !== '~') return null
  let count = 0
  while (trimmed[count] === marker) count += 1
  return count >= 3 ? marker : null
}

// Swift Double(String): plain decimal only (the marker is produced from digits and an optional fraction).
function swiftDouble(text: string): number | null {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text) : null
}
