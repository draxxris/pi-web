import { sessionPathKey } from "./session-path";

export interface SessionDeletionRecord {
  id: string;
  path: string;
  parentPath?: string;
  isSubagent: boolean;
}

export interface SessionReparentOperation {
  path: string;
  parentPath?: string;
}

export interface SessionDeletionPlan {
  deleteRecords: SessionDeletionRecord[];
  reparent: SessionReparentOperation[];
}

/**
 * Delete the selected session and marked j0k3r descendants while preserving
 * ordinary Pi fork sessions. Surviving children of deleted sessions are
 * attached to the nearest surviving ancestor.
 */
export function buildSessionDeletionPlan(
  records: readonly SessionDeletionRecord[],
  targetPath: string,
  targetId = "",
  targetParentPath?: string,
): SessionDeletionPlan {
  const byPath = new Map<string, SessionDeletionRecord>();
  for (const record of records) byPath.set(sessionPathKey(record.path), record);

  const targetKey = sessionPathKey(targetPath);
  if (!byPath.has(targetKey)) {
    byPath.set(targetKey, {
      id: targetId,
      path: targetPath,
      parentPath: targetParentPath,
      isSubagent: false,
    });
  }

  const childrenByParent = new Map<string, SessionDeletionRecord[]>();
  for (const record of byPath.values()) {
    if (!record.parentPath) continue;
    const parentKey = sessionPathKey(record.parentPath);
    const children = childrenByParent.get(parentKey) ?? [];
    children.push(record);
    childrenByParent.set(parentKey, children);
  }

  const deletedKeys = new Set<string>([targetKey]);
  const visited = new Set<string>();
  const pending = [targetKey];
  while (pending.length > 0) {
    const parentKey = pending.pop()!;
    if (visited.has(parentKey)) continue;
    visited.add(parentKey);

    for (const child of childrenByParent.get(parentKey) ?? []) {
      const childKey = sessionPathKey(child.path);
      if (child.isSubagent) deletedKeys.add(childKey);
      // Walk through ordinary forks too. A marked sub-agent can exist below
      // one, and it still belongs to the deleted root's descendant tree.
      pending.push(childKey);
    }
  }

  const deleteRecords = [...byPath.values()].filter((record) => deletedKeys.has(sessionPathKey(record.path)));
  const reparent: SessionReparentOperation[] = [];

  for (const record of byPath.values()) {
    const recordKey = sessionPathKey(record.path);
    if (deletedKeys.has(recordKey) || !record.parentPath) continue;
    if (!deletedKeys.has(sessionPathKey(record.parentPath))) continue;

    let parentPath: string | undefined = record.parentPath;
    const seenParents = new Set<string>();
    while (parentPath) {
      const parentKey = sessionPathKey(parentPath);
      if (!deletedKeys.has(parentKey)) break;
      if (seenParents.has(parentKey)) {
        parentPath = undefined;
        break;
      }
      seenParents.add(parentKey);
      parentPath = byPath.get(parentKey)?.parentPath;
    }
    reparent.push({ path: record.path, parentPath });
  }

  return { deleteRecords, reparent };
}
