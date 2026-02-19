import browser from 'webextension-polyfill';
import type { PerfReport } from '../perf/trace';

type MessageHandlerDeps = {
    onPerfReport: (report: PerfReport) => void;
    onHostPayloadRequest: (traceId: string, url: string) => Promise<void>;
    onCommentsCacheGet: (key: string) => unknown | null;
    onCommentsCacheSet: (key: string, value: unknown) => { ok: boolean; reason?: string; bytes?: number };
};

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createRuntimeMessageHandler(deps: MessageHandlerDeps) {
    return async (msg: unknown): Promise<unknown> => {
        if (!isJsonObject(msg)) return;

        const type = msg.type;
        if (type === 'PERF_REPORT') {
            const report = msg.report;
            if (isJsonObject(report) && typeof report.traceId === 'string' && Array.isArray(report.events)) {
                deps.onPerfReport(report as PerfReport);
            }
            return;
        }

        if (type === 'HOST_PAYLOAD_REQUEST') {
            const traceId = msg.traceId;
            const url = msg.url;
            if (typeof traceId !== 'string' || !traceId) return;
            if (typeof url !== 'string' || !url) return;
            await deps.onHostPayloadRequest(traceId, url);
            return;
        }

        if (type === 'COMMENTS_CACHE_GET') {
            const key = msg.key;
            if (typeof key !== 'string' || key.length > 400) return { hit: false };
            const value = deps.onCommentsCacheGet(key);
            return { hit: Boolean(value), value };
        }

        if (type === 'COMMENTS_CACHE_SET') {
            const key = msg.key;
            if (typeof key !== 'string' || key.length > 400) return { ok: false, reason: 'bad_key' };
            return deps.onCommentsCacheSet(key, msg.value);
        }
    };
}

export function installRuntimeMessageListener(deps: MessageHandlerDeps): void {
    if (!browser.runtime?.onMessage?.addListener) return;
    browser.runtime.onMessage.addListener(createRuntimeMessageHandler(deps));
}

export const __test__ = {
    createRuntimeMessageHandler,
};
