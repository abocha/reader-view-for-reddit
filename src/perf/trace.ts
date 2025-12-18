export type PerfEvent = {
    name: string;
    at: number;
    dur?: number;
    meta?: Record<string, unknown>;
};

export type PerfReport = {
    traceId: string;
    scope: 'background' | 'host' | 'comments';
    events: PerfEvent[];
    meta?: Record<string, unknown>;
};

const now = (): number => {
    try {
        return performance.now();
    } catch {
        return Date.now();
    }
};

export const perf = {
    now,
    event: (name: string, meta?: Record<string, unknown>): PerfEvent => ({ name, at: now(), meta }),
    span: (name: string, meta?: Record<string, unknown>) => {
        const start = now();
        const startEvent: PerfEvent = { name: `${name}:start`, at: start, meta };
        return {
            startEvent,
            end: (endMeta?: Record<string, unknown>): PerfEvent => ({
                name: `${name}:end`,
                at: now(),
                dur: now() - start,
                meta: endMeta,
            }),
        };
    },
};

export function summarize(events: PerfEvent[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of events) {
        if (typeof e.dur === 'number') out[e.name] = e.dur;
    }
    return out;
}

