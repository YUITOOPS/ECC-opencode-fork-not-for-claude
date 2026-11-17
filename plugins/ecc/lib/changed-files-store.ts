import * as path from "path"

export type ChangeType = "added" | "modified" | "deleted"

/**
 * One change store per process, not per module copy.
 *
 * OpenCode loads the plugin runtime and the tool modules through different
 * module graphs, so module-level state produced two independent Maps: the
 * runtime recorded changes into one and the changed-files tool read the other,
 * which therefore always answered "No files changed".
 *
 * Entries are stored as absolute paths. Every reader resolves them against the
 * location it is asked about, so two open projects do not see each other's
 * files.
 */
const STATE_KEY = Symbol.for("ecc.opencode.changedFiles")
const state = ((globalThis as unknown as Record<symbol, { changes: Map<string, ChangeType> }>)[STATE_KEY] ??= {
  changes: new Map<string, ChangeType>(),
})

/** Root of the location this module copy belongs to; readers may override it. */
let worktreeRoot = ""

export function initStore(worktree: string): void {
  worktreeRoot = worktree || process.cwd()
}

export function recordChange(filePath: string, type: ChangeType): void {
  if (!filePath) return
  state.changes.set(path.resolve(filePath), type)
}

/** Relative path inside `root`, or null when the file belongs to another location. */
function relativeTo(root: string | undefined, absolute: string): string | null {
  if (!root) return path.normalize(absolute)
  const base = path.resolve(root)
  const relative = path.relative(base, absolute)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative
}

export function getChanges(root?: string): Map<string, ChangeType> {
  const changes = new Map<string, ChangeType>()
  for (const [absolute, changeType] of state.changes) {
    const relative = relativeTo(root ?? worktreeRoot, absolute)
    if (relative) changes.set(relative, changeType)
  }
  return changes
}

export function clearChanges(): void {
  state.changes.clear()
}

export type TreeNode = {
  name: string
  path: string
  changeType?: ChangeType
  children: TreeNode[]
}

function addToTree(children: TreeNode[], segs: string[], fullPath: string, changeType: ChangeType): void {
  if (segs.length === 0) return
  const [head, ...rest] = segs
  let child = children.find((c) => c.name === head)

  if (rest.length === 0) {
    if (child) {
      child.changeType = changeType
      child.path = fullPath
    } else {
      children.push({ name: head, path: fullPath, changeType, children: [] })
    }
    return
  }

  if (!child) {
    const dirPath = segs.slice(0, -rest.length).join(path.sep)
    child = { name: head, path: dirPath, children: [] }
    children.push(child)
  }
  addToTree(child.children, rest, fullPath, changeType)
}

export function buildTree(filter?: ChangeType, root?: string): TreeNode[] {
  const rootNodes: TreeNode[] = []
  for (const [relPath, changeType] of getChanges(root)) {
    if (filter && changeType !== filter) continue
    const segs = relPath.split(path.sep).filter(Boolean)
    if (segs.length === 0) continue
    addToTree(rootNodes, segs, relPath, changeType)
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes].sort((a, b) => {
      const aIsFile = a.changeType !== undefined
      const bIsFile = b.changeType !== undefined
      if (aIsFile !== bIsFile) return aIsFile ? 1 : -1
      return a.name.localeCompare(b.name)
    }).map((n) => ({ ...n, children: sortNodes(n.children) }))
  }
  return sortNodes(rootNodes)
}

export function getChangedPaths(
  filter?: ChangeType,
  root?: string,
): Array<{ path: string; changeType: ChangeType }> {
  const list: Array<{ path: string; changeType: ChangeType }> = []
  for (const [p, t] of getChanges(root)) {
    if (filter && t !== filter) continue
    list.push({ path: p, changeType: t })
  }
  list.sort((a, b) => a.path.localeCompare(b.path))
  return list
}

export function hasChanges(root?: string): boolean {
  return getChanges(root).size > 0
}
