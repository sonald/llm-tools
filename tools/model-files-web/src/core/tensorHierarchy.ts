import type { TensorSummary } from './inspectors.ts'

export type TensorHierarchyNode = {
  readonly id: string
  readonly path: string
  readonly label: string
  readonly tensor: TensorSummary | undefined
  readonly descendantCount: number
  readonly children: readonly TensorHierarchyNode[]
}

type MutableNode = {
  label: string
  path: string
  tensor: TensorSummary | undefined
  children: Map<string, MutableNode>
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function filterTensorSummaries(
  tensors: readonly TensorSummary[],
  query: string,
): TensorSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...tensors]
  return tensors.filter(tensor =>
    tensor.name.toLocaleLowerCase().includes(needle) || tensor.dtype.toLocaleLowerCase().includes(needle),
  )
}

export function buildTensorHierarchy(tensors: readonly TensorSummary[]): TensorHierarchyNode[] {
  const roots = new Map<string, MutableNode>()
  for (const tensor of tensors) {
    const segments = tensor.name.split('.').filter(Boolean)
    const pathSegments = segments.length > 0 ? segments : tensor.name ? [tensor.name] : ['']
    let children = roots
    let node: MutableNode | undefined
    let path = ''
    for (const segment of pathSegments) {
      path = path ? `${path}.${segment}` : segment
      node = children.get(segment)
      if (!node) {
        node = { label: segment, path, tensor: undefined, children: new Map() }
        children.set(segment, node)
      }
      children = node.children
    }
    if (node) node.tensor = tensor
  }
  return sortNodes(roots.values()).map(freezeNode)
}

export function autoExpandMatchingPaths(
  roots: readonly TensorHierarchyNode[],
  query = '',
): Set<string> {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return new Set()

  const matchingGroups = new Set<string>()
  const visit = (node: TensorHierarchyNode): boolean => {
    const ownMatch = node.tensor !== undefined && matches(node.tensor, needle)
    const childMatch = node.children.some(visit)
    const matched = ownMatch || childMatch
    if (node.children.length > 0 && matched) matchingGroups.add(node.id)
    return matched
  }
  roots.forEach(visit)

  const ordered: string[] = []
  const collect = (node: TensorHierarchyNode) => {
    if (matchingGroups.has(node.id)) ordered.push(node.id)
    node.children.forEach(collect)
  }
  roots.forEach(collect)
  return new Set(ordered)
}

export function flattenTensorHierarchy(
  roots: readonly TensorHierarchyNode[],
  expandedGroupIds: ReadonlySet<string>,
): Array<TensorHierarchyNode & { readonly depth: number }> {
  const rows: Array<TensorHierarchyNode & { readonly depth: number }> = []
  const visit = (node: TensorHierarchyNode, depth: number) => {
    rows.push({ ...node, depth })
    if (node.children.length === 0 || !expandedGroupIds.has(node.id)) return
    if (node.tensor !== undefined) {
      rows.push({
        ...node,
        id: `tensor:${node.tensor.name}`,
        tensor: node.tensor,
        descendantCount: 1,
        children: [],
        depth: depth + 1,
      })
    }
    node.children.forEach(child => visit(child, depth + 1))
  }
  roots.forEach(root => visit(root, 0))
  return rows
}

function freezeNode(node: MutableNode): TensorHierarchyNode {
  const children = sortNodes(node.children.values()).map(freezeNode)
  const isGroup = children.length > 0 || node.tensor === undefined
  const descendantCount = children.reduce((count, child) => count + child.descendantCount, node.tensor ? 1 : 0)
  return {
    id: isGroup ? `group:${node.path}` : `tensor:${node.tensor?.name ?? node.path}`,
    path: node.path,
    label: node.label,
    tensor: node.tensor,
    descendantCount,
    children,
  }
}

function sortNodes(nodes: Iterable<MutableNode>): MutableNode[] {
  return [...nodes].sort((left, right) => {
    const byLabel = naturalOrder.compare(left.label, right.label)
    if (byLabel !== 0) return byLabel
    return naturalOrder.compare(left.path, right.path)
  })
}

function matches(tensor: TensorSummary, needle: string): boolean {
  return tensor.name.toLocaleLowerCase().includes(needle) || tensor.dtype.toLocaleLowerCase().includes(needle)
}
