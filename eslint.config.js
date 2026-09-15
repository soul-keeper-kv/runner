// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Architecture boundaries are enforced by lint, not by convention alone.
 * See docs/architecture/01-layering.md and .claude/skills/runner-architecture.
 */
const FORBIDDEN_PLAYWRIGHT = {
  group: ['playwright', 'playwright-core', 'playwright/*', '@playwright/*'],
  message:
    'Playwright may only be imported inside infrastructure adapters (apps/worker/src/infrastructure/playwright). Depend on BrowserPort instead.',
};

const FORBIDDEN_PERSISTENCE = {
  group: ['drizzle-orm', 'drizzle-orm/*', 'pg', 'postgres', 'ioredis', 'bullmq'],
  message:
    'Persistence and queue clients belong in the infrastructure layer. Depend on a port interface instead.',
};

const FORBIDDEN_NEST = {
  group: ['@nestjs/*'],
  message:
    'Framework decorators belong in the presentation/infrastructure layer, not in domain or application code.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },

  // ---- Rule 2 + 12: domain stays pure ----
  {
    files: ['packages/domain/**/*.ts', 'apps/worker/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [FORBIDDEN_PLAYWRIGHT, FORBIDDEN_PERSISTENCE, FORBIDDEN_NEST],
        },
      ],
    },
  },

  // ---- Rule 3 + 4 + 13: application depends on ports only ----
  {
    files: ['packages/application/**/*.ts', 'apps/worker/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [FORBIDDEN_PLAYWRIGHT, FORBIDDEN_PERSISTENCE, FORBIDDEN_NEST],
        },
      ],
    },
  },

  // ---- Capabilities orchestrate through ports, never through Playwright ----
  {
    files: ['apps/worker/src/capabilities/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [FORBIDDEN_PLAYWRIGHT] }],
    },
  },

  // ---- Rule 5: the live UI must not learn Playwright internals ----
  {
    files: ['apps/live-web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            FORBIDDEN_PLAYWRIGHT,
            FORBIDDEN_PERSISTENCE,
            {
              group: ['@runner/domain', '@runner/domain/*'],
              message:
                'The live workspace consumes the public wire protocol (@runner/live-protocol), not Runner internal domain models.',
            },
          ],
        },
      ],
    },
  },

  // ---- Wire contract packages stay dependency-free and serializable ----
  {
    files: [
      'packages/test-ir-model/**/*.ts',
      'packages/selector-model/**/*.ts',
      'packages/registry-model/**/*.ts',
      'packages/live-protocol/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            FORBIDDEN_PLAYWRIGHT,
            FORBIDDEN_PERSISTENCE,
            FORBIDDEN_NEST,
            {
              group: ['@runner/domain', '@runner/domain/*', '@runner/application'],
              message:
                'Wire models must not depend on internal domain models. Mapping happens at the API boundary.',
            },
          ],
        },
      ],
    },
  },

  // ---- Tests may relax a few rules ----
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
