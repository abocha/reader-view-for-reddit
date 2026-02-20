export type CommentNode = {
    id: string;
    author: string;
    bodyMarkdown: string;
    bodyHtml: string;
    score?: number;
    createdUtc?: number;
    moreChildrenIds?: string[];
    replies: CommentNode[];
};

export type CommentGraphNode = {
    id: string;
    parentId: string | null;
    author: string;
    bodyMarkdown: string;
    bodyHtml: string;
    score?: number;
    createdUtc?: number;
    moreChildrenIds: string[];
    childIds: string[];
};

export type CommentGraphState = {
    nodesById: Map<string, CommentGraphNode>;
    rootIds: string[];
    rootMoreChildrenIds: string[];
    hasMoreMarker: boolean;
    hasMore: boolean;
};

export type GraphPlaceholder = {
    parentId: string | null;
    childrenIds: string[];
    depth: number;
    rootId: string | null;
    sourcePath: string;
};

export type GraphMergeResult = {
    insertedCount: number;
    updatedCount: number;
    newPlaceholders: GraphPlaceholder[];
    orphansSkipped: number;
};

export type BuildGraphResult = {
    graph: CommentGraphState;
    loadedCount: number;
};

export function dedupeIds(ids: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function parseMoreChildrenIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
}

export function normalizeThingId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('t1_') || trimmed.startsWith('t3_')) return trimmed.slice(3);
    return trimmed;
}

export function normalizeParentCommentId(parentThingId: unknown, postId: string): string | null {
    if (typeof parentThingId !== 'string' || !parentThingId) return null;
    if (parentThingId.startsWith('t3_')) return null;
    const normalized = normalizeThingId(parentThingId);
    if (!normalized || normalized === postId) return null;
    return normalized;
}

export function createEmptyCommentGraphState(): CommentGraphState {
    return {
        nodesById: new Map<string, CommentGraphNode>(),
        rootIds: [],
        rootMoreChildrenIds: [],
        hasMoreMarker: false,
        hasMore: false,
    };
}

function countCommentNodes(node: CommentNode): number {
    let n = 1;
    for (const child of node.replies) n += countCommentNodes(child);
    return n;
}

function pushUnique(values: string[], value: string): void {
    if (!values.includes(value)) values.push(value);
}

function attachNodeToParent(graph: CommentGraphState, nodeId: string, parentId: string | null): boolean {
    const node = graph.nodesById.get(nodeId);
    if (!node) return false;

    if (parentId === null) {
        if (node.parentId === null) pushUnique(graph.rootIds, nodeId);
        return true;
    }

    const parent = graph.nodesById.get(parentId);
    if (!parent) return false;

    if (node.parentId === null) node.parentId = parentId;
    if (node.parentId === parentId) pushUnique(parent.childIds, nodeId);

    return true;
}

function upsertNodeFromComment(graph: CommentGraphState, comment: CommentNode, parentId: string | null): CommentGraphNode | null {
    const id = String(comment.id || '').trim();
    if (!id) return null;

    let node = graph.nodesById.get(id);
    if (!node) {
        node = {
            id,
            parentId,
            author: comment.author || 'unknown',
            bodyMarkdown: comment.bodyMarkdown || '',
            bodyHtml: comment.bodyHtml || '',
            score: typeof comment.score === 'number' ? comment.score : undefined,
            createdUtc: typeof comment.createdUtc === 'number' ? comment.createdUtc : undefined,
            moreChildrenIds: dedupeIds(comment.moreChildrenIds ?? []),
            childIds: [],
        };
        graph.nodesById.set(id, node);
    } else {
        node.author = comment.author || node.author;
        node.bodyMarkdown = comment.bodyMarkdown || node.bodyMarkdown;
        node.bodyHtml = comment.bodyHtml || node.bodyHtml;
        node.score = typeof comment.score === 'number' ? comment.score : node.score;
        node.createdUtc = typeof comment.createdUtc === 'number' ? comment.createdUtc : node.createdUtc;
        node.moreChildrenIds = dedupeIds([...(node.moreChildrenIds ?? []), ...(comment.moreChildrenIds ?? [])]);
    }

    if (!attachNodeToParent(graph, id, parentId)) return null;
    return node;
}

function insertCommentTree(graph: CommentGraphState, comment: CommentNode, parentId: string | null): void {
    const node = upsertNodeFromComment(graph, comment, parentId);
    if (!node) return;
    for (const reply of comment.replies) {
        insertCommentTree(graph, reply, node.id);
    }
}

export function rebuildGraphFromRoots(
    roots: CommentNode[],
    options?: { hasMoreMarker?: boolean; rootMoreChildrenIds?: string[] },
): CommentGraphState {
    const graph = createEmptyCommentGraphState();
    graph.hasMoreMarker = Boolean(options?.hasMoreMarker);
    graph.rootMoreChildrenIds = dedupeIds(options?.rootMoreChildrenIds ?? []);

    for (const root of roots) {
        insertCommentTree(graph, root, null);
    }

    refreshHasMoreState(graph);
    return graph;
}

export function buildGraphFromListing(
    children: unknown[] | undefined,
    parseCommentThing: (wrapper: unknown, remainingDepth: number) => CommentNode | null,
): BuildGraphResult {
    const graph = createEmptyCommentGraphState();
    if (!Array.isArray(children)) return { graph, loadedCount: 0 };

    let loadedCount = 0;
    for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        const kind = (child as { kind?: unknown }).kind;

        if (kind === 'more') {
            graph.hasMoreMarker = true;
            graph.rootMoreChildrenIds = dedupeIds([
                ...graph.rootMoreChildrenIds,
                ...parseMoreChildrenIds((child as any)?.data?.children),
            ]);
            continue;
        }

        if (kind !== 't1') continue;
        const node = parseCommentThing(child, 10);
        if (!node) continue;
        loadedCount += countCommentNodes(node);
        insertCommentTree(graph, node, null);
    }

    refreshHasMoreState(graph);
    return { graph, loadedCount };
}

function projectNode(graph: CommentGraphState, nodeId: string, pathVisited: Set<string>): CommentNode | null {
    if (pathVisited.has(nodeId)) return null;
    const node = graph.nodesById.get(nodeId);
    if (!node) return null;

    pathVisited.add(nodeId);
    const replies: CommentNode[] = [];
    for (const childId of node.childIds) {
        const reply = projectNode(graph, childId, pathVisited);
        if (reply) replies.push(reply);
    }
    pathVisited.delete(nodeId);

    return {
        id: node.id,
        author: node.author,
        bodyMarkdown: node.bodyMarkdown,
        bodyHtml: node.bodyHtml,
        score: node.score,
        createdUtc: node.createdUtc,
        moreChildrenIds: [...node.moreChildrenIds],
        replies,
    };
}

export function projectRootsFromGraph(graph: CommentGraphState): CommentNode[] {
    const out: CommentNode[] = [];
    for (const rootId of graph.rootIds) {
        const node = projectNode(graph, rootId, new Set<string>());
        if (node) out.push(node);
    }
    return out;
}

export function collectPlaceholdersForScope(graph: CommentGraphState, scopeParentId: string | null): GraphPlaceholder[] {
    const placeholders: GraphPlaceholder[] = [];

    const collectFromNode = (
        nodeId: string,
        depth: number,
        rootId: string | null,
        sourcePath: string,
        pathVisited: Set<string>,
    ): void => {
        if (pathVisited.has(nodeId)) return;
        const node = graph.nodesById.get(nodeId);
        if (!node) return;

        pathVisited.add(nodeId);
        if (node.moreChildrenIds.length > 0) {
            placeholders.push({
                parentId: node.id,
                childrenIds: [...node.moreChildrenIds],
                depth,
                rootId,
                sourcePath,
            });
        }

        for (let i = 0; i < node.childIds.length; i += 1) {
            const childId = node.childIds[i]!;
            collectFromNode(childId, depth + 1, rootId, `${sourcePath}.${i + 1}`, pathVisited);
        }

        pathVisited.delete(nodeId);
    };

    if (scopeParentId === null) {
        if (graph.rootMoreChildrenIds.length > 0) {
            placeholders.push({
                parentId: null,
                childrenIds: [...graph.rootMoreChildrenIds],
                depth: 0,
                rootId: null,
                sourcePath: 'root',
            });
        }

        for (let i = 0; i < graph.rootIds.length; i += 1) {
            const rootId = graph.rootIds[i]!;
            collectFromNode(rootId, 0, rootId, `${i + 1}`, new Set<string>());
        }
        return placeholders;
    }

    if (!graph.nodesById.has(scopeParentId)) return placeholders;
    collectFromNode(scopeParentId, 0, scopeParentId, scopeParentId, new Set<string>());
    return placeholders;
}

export function consumePlaceholderIds(graph: CommentGraphState, parentId: string | null, consumedIds: string[]): void {
    const consumed = new Set(consumedIds);
    if (consumed.size === 0) return;

    if (parentId === null) {
        graph.rootMoreChildrenIds = graph.rootMoreChildrenIds.filter(id => !consumed.has(id));
        refreshHasMoreState(graph);
        return;
    }

    const parent = graph.nodesById.get(parentId);
    if (!parent) return;
    parent.moreChildrenIds = parent.moreChildrenIds.filter(id => !consumed.has(id));
    refreshHasMoreState(graph);
}

function appendPlaceholderIds(graph: CommentGraphState, parentId: string | null, ids: string[]): boolean {
    const nextIds = dedupeIds(ids);
    if (nextIds.length === 0) return false;

    if (parentId === null) {
        graph.rootMoreChildrenIds = dedupeIds([...graph.rootMoreChildrenIds, ...nextIds]);
        return true;
    }

    const parent = graph.nodesById.get(parentId);
    if (!parent) return false;
    parent.moreChildrenIds = dedupeIds([...(parent.moreChildrenIds ?? []), ...nextIds]);
    return true;
}

function nodeDepth(graph: CommentGraphState, nodeId: string): number {
    let depth = 0;
    let current = graph.nodesById.get(nodeId);
    const seen = new Set<string>();

    while (current && current.parentId) {
        if (seen.has(current.id)) break;
        seen.add(current.id);
        const parent = graph.nodesById.get(current.parentId);
        if (!parent) break;
        depth += 1;
        current = parent;
    }

    return depth;
}

function mergeIncomingCommentNode(
    graph: CommentGraphState,
    result: GraphMergeResult,
    parentId: string | null,
    incoming: CommentNode,
): CommentGraphNode | null {
    const id = String(incoming.id || '').trim();
    if (!id) {
        result.orphansSkipped += 1;
        return null;
    }

    const existing = graph.nodesById.get(id);
    if (existing) {
        existing.author = incoming.author || existing.author;
        existing.bodyMarkdown = incoming.bodyMarkdown || existing.bodyMarkdown;
        existing.bodyHtml = incoming.bodyHtml || existing.bodyHtml;
        existing.score = typeof incoming.score === 'number' ? incoming.score : existing.score;
        existing.createdUtc = typeof incoming.createdUtc === 'number' ? incoming.createdUtc : existing.createdUtc;
        existing.moreChildrenIds = dedupeIds([...(existing.moreChildrenIds ?? []), ...(incoming.moreChildrenIds ?? [])]);

        if (parentId === null && existing.parentId === null) {
            pushUnique(graph.rootIds, existing.id);
        } else if (parentId !== null && graph.nodesById.has(parentId) && existing.parentId === parentId) {
            const parent = graph.nodesById.get(parentId)!;
            pushUnique(parent.childIds, existing.id);
        }

        result.updatedCount += 1;
        for (const child of incoming.replies) {
            mergeIncomingCommentNode(graph, result, existing.id, child);
        }
        return existing;
    }

    if (parentId !== null && !graph.nodesById.has(parentId)) {
        result.orphansSkipped += 1;
        return null;
    }

    const created: CommentGraphNode = {
        id,
        parentId,
        author: incoming.author,
        bodyMarkdown: incoming.bodyMarkdown,
        bodyHtml: incoming.bodyHtml,
        score: incoming.score,
        createdUtc: incoming.createdUtc,
        moreChildrenIds: dedupeIds(incoming.moreChildrenIds ?? []),
        childIds: [],
    };

    graph.nodesById.set(created.id, created);
    if (parentId === null) {
        pushUnique(graph.rootIds, created.id);
    } else {
        const parent = graph.nodesById.get(parentId);
        if (parent) pushUnique(parent.childIds, created.id);
    }

    result.insertedCount += 1;
    for (const child of incoming.replies) {
        mergeIncomingCommentNode(graph, result, created.id, child);
    }
    return created;
}

export function mergeMoreChildrenThingsIntoGraph(
    graph: CommentGraphState,
    things: unknown[],
    postId: string,
    parseCommentThing: (wrapper: unknown, remainingDepth: number) => CommentNode | null,
): GraphMergeResult {
    const result: GraphMergeResult = {
        insertedCount: 0,
        updatedCount: 0,
        newPlaceholders: [],
        orphansSkipped: 0,
    };

    if (!Array.isArray(things) || things.length === 0) {
        refreshHasMoreState(graph);
        return result;
    }

    for (const thing of things) {
        if (!thing || typeof thing !== 'object') continue;
        const kind = (thing as { kind?: unknown }).kind;

        if (kind === 't1') {
            const node = parseCommentThing(thing, 10);
            if (!node) continue;
            const parentId = normalizeParentCommentId((thing as any)?.data?.parent_id, postId);
            const merged = mergeIncomingCommentNode(graph, result, parentId, node);
            if (!merged) continue;
            if (merged.moreChildrenIds.length > 0) {
                result.newPlaceholders.push({
                    parentId: merged.id,
                    childrenIds: [...merged.moreChildrenIds],
                    depth: nodeDepth(graph, merged.id),
                    rootId: null,
                    sourcePath: merged.id,
                });
            }
            continue;
        }

        if (kind === 'more') {
            const parentId = normalizeParentCommentId((thing as any)?.data?.parent_id, postId);
            const childrenIds = parseMoreChildrenIds((thing as any)?.data?.children);
            const appended = appendPlaceholderIds(graph, parentId, childrenIds);
            if (appended) {
                result.newPlaceholders.push({
                    parentId,
                    childrenIds,
                    depth: parentId ? nodeDepth(graph, parentId) + 1 : 0,
                    rootId: null,
                    sourcePath: parentId ?? 'root',
                });
            }
        }
    }

    refreshHasMoreState(graph);
    return result;
}

export function hasResolvableMorePlaceholders(graph: CommentGraphState): boolean {
    if (graph.rootMoreChildrenIds.length > 0) return true;
    for (const node of graph.nodesById.values()) {
        if (node.moreChildrenIds.length > 0) return true;
    }
    return false;
}

export function refreshHasMoreState(graph: CommentGraphState): void {
    graph.hasMore = graph.hasMoreMarker || hasResolvableMorePlaceholders(graph);
}
