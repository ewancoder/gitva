import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**'] },
    ...tseslint.configs.recommendedTypeChecked,
    { languageOptions: { parserOptions: { projectService: true } } },
    // Do not check types for JS.
    { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
    {
        files: ['test/**'],
        rules: {
            // These are floating by design.
            '@typescript-eslint/no-floating-promises': [
                'error',
                {
                    allowForKnownSafeCalls: [
                        { from: 'package', package: 'node:test', name: ['describe', 'it', 'test'] },
                    ],
                },
            ],
        },
    },
);
