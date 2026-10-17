import { chmod } from 'node:fs/promises';

const LICENSE_HEADER = `#!/usr/bin/env bun
/*
 * pinets-cli - CLI for PineTS
 * Copyright (C) 2025 Alaa-eddine KADDOURI
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * Bundled components retain their own licenses; see THIRD_PARTY_NOTICES.
 */`;

type BuildMode = 'dev' | 'prod';

function parseBuildMode(value: string | undefined): BuildMode {
    switch (value) {
        case undefined:
        case 'prod':
            return 'prod';
        case 'dev':
            return 'dev';
        default:
            throw new TypeError(`Unsupported build mode: ${value}`);
    }
}

const mode = parseBuildMode(process.argv[2]);
const isProduction = mode === 'prod';
const result = await Bun.build({
    entrypoints: ['./src/index.ts'],
    outdir: './dist',
    target: 'bun',
    format: 'cjs',
    naming: isProduction ? 'pinets-cli.min.cjs' : 'pinets-cli.dev.cjs',
    sourcemap: 'linked',
    minify: isProduction,
    packages: 'bundle',
    banner: LICENSE_HEADER,
});

if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
}

if (isProduction) {
    const aliasPath = './dist/pinets-cli.cjs';
    await Bun.write(aliasPath, '#!/usr/bin/env bun\nrequire("./pinets-cli.min.cjs");\n');
    await chmod(aliasPath, 0o755);
}
