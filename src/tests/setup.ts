
import { vi } from 'vitest';

// Stub webextension-polyfill
const browserMock = {
    runtime: {
        getURL: vi.fn(),
        sendMessage: vi.fn(),
        onInstalled: { addListener: vi.fn() },
    },
    tabs: {
        create: vi.fn(),
        update: vi.fn(),
        query: vi.fn(),
    },
    scripting: {
        executeScript: vi.fn(),
    },
    storage: {
        sync: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue(undefined)
        },
        local: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue(undefined)
        },
        session: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue(undefined)
        }
    },
    action: {
        onClicked: { addListener: vi.fn() },
    },
    commands: {
        onCommand: { addListener: vi.fn() },
    },
    menus: {
        create: vi.fn(),
        removeAll: vi.fn(),
        onClicked: { addListener: vi.fn() },
    },
};

vi.mock('webextension-polyfill', () => ({
    default: browserMock,
    __esModule: true,
}));

// Global fetches stub (can be overridden in specific tests)
globalThis.fetch = vi.fn();

// Crypto stub
if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
        value: {
            randomUUID: () => 'test-uuid-1234',
        },
    });
}
