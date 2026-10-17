type SemanticVersion = {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: readonly string[];
};

/**
 * Lightweight update check against the package registry.
 *
 * The entire request, including its response body, is bounded by the timeout.
 * Returns a formatted notice only when the registry version is newer.
 */
export async function checkForUpdate(
    currentVersion: string,
    packageName: string,
    timeoutMs = 1_000,
): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const encodedPackageName = encodeURIComponent(packageName);
        const response = await fetch(
            `https://registry.npmjs.org/${encodedPackageName}/latest`,
            { signal: controller.signal },
        );
        if (!response.ok) return null;

        const payload: unknown = await response.json();
        if (!isRecord(payload) || typeof payload['version'] !== 'string') {
            return null;
        }

        const latestVersion = payload['version'];
        if (!isNewerVersion(latestVersion, currentVersion)) {
            return null;
        }

        return [
            '',
            `  Update available: ${currentVersion} \u2192 ${latestVersion}`,
            `  Run: bun add -g ${packageName}`,
            '',
        ].join('\n');
    } catch (error) {
        if (
            error instanceof TypeError ||
            error instanceof SyntaxError ||
            error instanceof DOMException
        ) {
            return null;
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function isNewerVersion(candidate: string, current: string): boolean {
    const candidateVersion = parseSemanticVersion(candidate);
    const currentVersion = parseSemanticVersion(current);
    if (!candidateVersion || !currentVersion) {
        return false;
    }
    return compareSemanticVersions(candidateVersion, currentVersion) > 0;
}

function parseSemanticVersion(value: string): SemanticVersion | null {
    const match =
        /^v?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
            value,
        );
    const groups = match?.groups;
    if (!groups) return null;

    const major = Number(groups['major']);
    const minor = Number(groups['minor']);
    const patch = Number(groups['patch']);
    if (
        !Number.isSafeInteger(major) ||
        !Number.isSafeInteger(minor) ||
        !Number.isSafeInteger(patch)
    ) {
        return null;
    }

    const prerelease = groups['prerelease']?.split('.') ?? [];
    if (
        prerelease.some(
            (identifier) =>
                /^\d+$/.test(identifier) &&
                identifier.length > 1 &&
                identifier.startsWith('0'),
        )
    ) {
        return null;
    }

    return { major, minor, patch, prerelease };
}

function compareSemanticVersions(
    candidate: SemanticVersion,
    current: SemanticVersion,
): number {
    for (const key of ['major', 'minor', 'patch'] as const) {
        const difference = candidate[key] - current[key];
        if (difference !== 0) return Math.sign(difference);
    }

    if (candidate.prerelease.length === 0) {
        return current.prerelease.length === 0 ? 0 : 1;
    }
    if (current.prerelease.length === 0) return -1;

    const identifierCount = Math.max(
        candidate.prerelease.length,
        current.prerelease.length,
    );
    for (let index = 0; index < identifierCount; index += 1) {
        const candidateIdentifier = candidate.prerelease[index];
        const currentIdentifier = current.prerelease[index];
        if (candidateIdentifier === undefined) return -1;
        if (currentIdentifier === undefined) return 1;
        if (candidateIdentifier === currentIdentifier) continue;

        const candidateNumber = numericIdentifier(candidateIdentifier);
        const currentNumber = numericIdentifier(currentIdentifier);
        if (candidateNumber !== null && currentNumber !== null) {
            return Math.sign(candidateNumber - currentNumber);
        }
        if (candidateNumber !== null) return -1;
        if (currentNumber !== null) return 1;
        return candidateIdentifier < currentIdentifier ? -1 : 1;
    }
    return 0;
}

function numericIdentifier(value: string): number | null {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
