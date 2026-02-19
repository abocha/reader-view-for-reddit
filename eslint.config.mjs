import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const browserGlobals = {
    ...globals.browser,
    ...globals.es2022,
    __DEV__: 'readonly',
};

const nodeGlobals = {
    ...globals.node,
    ...globals.es2022,
};

const vitestGlobals = {
    describe: 'readonly',
    it: 'readonly',
    expect: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly',
    beforeAll: 'readonly',
    afterAll: 'readonly',
    vi: 'readonly',
};

export default tseslint.config(
    {
        ignores: [
            'dist/**',
            'coverage/**',
            'web-ext-artifacts/**',
            'node_modules/**',
            'tmp/**',
        ],
    },
    {
        files: ['src/**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            parserOptions: {
                projectService: true,
            },
            globals: browserGlobals,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
    {
        files: ['src/tests/**/*.ts'],
        languageOptions: {
            globals: {
                ...browserGlobals,
                ...vitestGlobals,
            },
        },
        rules: {
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',
        },
    },
    {
        files: ['build.js', 'scripts/**/*.mjs'],
        extends: [js.configs.recommended],
        languageOptions: {
            sourceType: 'module',
            globals: nodeGlobals,
        },
    },
);
