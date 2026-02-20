import type { CommentNode } from './comments-graph';

export type VisibilityPlanLike = {
    visibleChildrenByParentId: Map<string, string[]>;
    collapsedLowByParentId: Map<string, string[]>;
    hiddenDepthCountByParentId: Map<string, number>;
};

export type RenderTreeSettingsLike = {
    depthLimit: number;
    visibilityPlan: VisibilityPlanLike;
    searchActive?: boolean;
};

export type ProjectionRenderItem = {
    top: CommentNode;
    settings: RenderTreeSettingsLike;
};

export type ProjectionState = {
    collapsedById: Set<string>;
    expandedMoreById: Set<string>;
    expandedLowScoreById: Set<string>;
    autoModeratorExpandedById: Set<string>;
};

export type ProjectedCommentNode = {
    id: string;
    parentId: string | null;
    depth: number;
    orderKey: string;
    collapsed: boolean;
    forcedLowScoreCollapse: boolean;
    hiddenDepthCount: number;
    unresolvedMoreCount: number;
    childIds: string[];
};

export type ProjectedRootEntry = {
    key: string;
    commentId: string;
    orderKey: string;
    itemIndex: number;
    signature: string;
};

export type CommentProjection = {
    roots: ProjectedRootEntry[];
    byId: Map<string, ProjectedCommentNode>;
};

function getVisibleChildrenFromPlan(comment: CommentNode, plan: VisibilityPlanLike): {
    visible: CommentNode[];
    lowScoreCollapsed: CommentNode[];
    hiddenDepthCount: number;
} {
    const byId = new Map(comment.replies.map(reply => [reply.id, reply] as const));
    const visibleIds = plan.visibleChildrenByParentId.get(comment.id) ?? [];
    const collapsedIds = plan.collapsedLowByParentId.get(comment.id) ?? [];
    const hiddenDepthCount = plan.hiddenDepthCountByParentId.get(comment.id) ?? 0;

    const visible = visibleIds
        .map(id => byId.get(id))
        .filter((node): node is CommentNode => Boolean(node));
    const lowScoreCollapsed = collapsedIds
        .map(id => byId.get(id))
        .filter((node): node is CommentNode => Boolean(node));

    return { visible, lowScoreCollapsed, hiddenDepthCount };
}

function safeProjectionId(baseId: string, orderKey: string, byId: Map<string, ProjectedCommentNode>): string {
    const cleaned = baseId || '(unknown)';
    if (!byId.has(cleaned)) return cleaned;
    const candidate = `${cleaned}#${orderKey}`;
    if (!byId.has(candidate)) return candidate;

    let n = 2;
    while (byId.has(`${candidate}.${n}`)) n += 1;
    return `${candidate}.${n}`;
}

function fingerprintText(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
}

function getRootSignature(rootId: string, byId: Map<string, ProjectedCommentNode>, itemsById: Map<string, CommentNode>): string {
    const lines: string[] = [];

    const walk = (id: string): void => {
        const projected = byId.get(id);
        const source = itemsById.get(id);
        if (!projected) return;
        const bodyMarkdown = (source?.bodyMarkdown || '').trim();
        const bodyHtml = source?.bodyHtml || '';
        const author = source?.author || 'unknown';
        const score = typeof source?.score === 'number' ? String(source.score) : 'na';
        const createdUtc = typeof source?.createdUtc === 'number' ? String(source.createdUtc) : 'na';
        lines.push([
            projected.id,
            projected.parentId ?? 'null',
            projected.collapsed ? 'c1' : 'c0',
            projected.forcedLowScoreCollapse ? 'l1' : 'l0',
            `h${projected.hiddenDepthCount}`,
            `m${projected.unresolvedMoreCount}`,
            `a${fingerprintText(author)}`,
            `s${score}`,
            `t${createdUtc}`,
            `bm${bodyMarkdown.length}:${fingerprintText(bodyMarkdown)}`,
            `bh${bodyHtml.length}:${fingerprintText(bodyHtml)}`,
            `k${projected.childIds.length}`,
            `ch${fingerprintText(projected.childIds.join(','))}`,
        ].join('|'));

        for (const childId of projected.childIds) walk(childId);
    };

    walk(rootId);
    return lines.join('||');
}

export function buildCommentProjection(
    renderItems: ProjectionRenderItem[],
    state: ProjectionState,
): CommentProjection {
    const byId = new Map<string, ProjectedCommentNode>();
    const roots: ProjectedRootEntry[] = [];
    const sourceById = new Map<string, CommentNode>();

    const walk = (
        comment: CommentNode,
        settings: RenderTreeSettingsLike,
        depth: number,
        parentId: string | null,
        orderKey: string,
        unlimitedDepth: boolean,
        options?: { forceCollapsed?: boolean; lowScore?: boolean },
    ): string => {
        const baseId = comment.id || '(unknown)';
        const projectionId = safeProjectionId(baseId, orderKey, byId);
        sourceById.set(projectionId, comment);

        const searchActive = Boolean(settings.searchActive);
        const isAutoModerator = comment.author.trim().toLowerCase() === 'automoderator';
        const autoCollapsed = !searchActive && isAutoModerator && !state.autoModeratorExpandedById.has(comment.id);
        const isCollapsed = !searchActive && (Boolean(options?.forceCollapsed) || state.collapsedById.has(comment.id) || autoCollapsed);

        const projected: ProjectedCommentNode = {
            id: projectionId,
            parentId,
            depth,
            orderKey,
            collapsed: isCollapsed,
            forcedLowScoreCollapse: Boolean(options?.lowScore),
            hiddenDepthCount: 0,
            unresolvedMoreCount: comment.moreChildrenIds?.length ?? 0,
            childIds: [],
        };
        byId.set(projectionId, projected);

        if (isCollapsed) return projectionId;

        const thisSubtreeUnlimited = unlimitedDepth || state.expandedMoreById.has(comment.id);
        if (comment.replies.length > 0) {
            const { visible, lowScoreCollapsed, hiddenDepthCount } = getVisibleChildrenFromPlan(comment, settings.visibilityPlan);
            projected.hiddenDepthCount = hiddenDepthCount;

            let childIndex = 0;
            for (const child of visible) {
                childIndex += 1;
                const childId = walk(child, settings, depth + 1, projectionId, `${orderKey}.${childIndex}`, thisSubtreeUnlimited);
                projected.childIds.push(childId);
            }
            for (const child of lowScoreCollapsed) {
                childIndex += 1;
                const childId = walk(
                    child,
                    settings,
                    depth + 1,
                    projectionId,
                    `${orderKey}.${childIndex}`,
                    thisSubtreeUnlimited,
                    { forceCollapsed: true, lowScore: true },
                );
                projected.childIds.push(childId);
            }
        }

        return projectionId;
    };

    for (let i = 0; i < renderItems.length; i += 1) {
        const item = renderItems[i]!;
        const orderKey = String(i + 1);
        const rootProjectionId = walk(item.top, item.settings, 0, null, orderKey, false);
        const signature = getRootSignature(rootProjectionId, byId, sourceById);
        roots.push({
            key: rootProjectionId,
            commentId: item.top.id,
            orderKey,
            itemIndex: i,
            signature,
        });
    }

    return { roots, byId };
}
