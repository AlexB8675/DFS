import type { DriveNode } from '@dfs/shared'

/**
 * Whether `nodes` may be dropped into the folder `targetId`. Not into one of
 * the dragged folders, not into a folder below one of them (`targetScopes`
 * lists the target and its ancestors, where known), and not where they all
 * already are, which would do nothing. The server checks cycles too; this
 * only decides what to highlight.
 */
export function canDrop(
  nodes: readonly Pick<DriveNode, 'id' | 'parentId'>[],
  targetId: string,
  targetScopes: readonly string[] = [],
): boolean {
  if (nodes.length === 0) return false
  if (nodes.every((node) => node.parentId === targetId)) return false
  return !nodes.some((node) => node.id === targetId || targetScopes.includes(node.id))
}

/**
 * The folder IDs that enclose `element`, innermost first, from the
 * `data-folder-scope` attributes of the folder tree's nested items.
 */
export function scopesOf(element: Element): string[] {
  const scopes: string[] = []
  for (
    let scope = element.closest<HTMLElement>('[data-folder-scope]');
    scope;
    scope = scope.parentElement?.closest<HTMLElement>('[data-folder-scope]') ?? null
  ) {
    if (scope.dataset.folderScope) scopes.push(scope.dataset.folderScope)
  }
  return scopes
}
