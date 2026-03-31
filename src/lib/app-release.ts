type AppReleaseDefaults = {
  appName: string;
  defaultVersion: string;
  defaultUpstreamRepo: string;
};

export type AppReleaseStatus = {
  appName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseChannel: string;
  deploymentUrl: string | null;
  upstreamRepo: string;
  latestUrl: string | null;
  changelogUrl: string | null;
  currentCommit: string | null;
  buildTime: string | null;
  checkedAt: string;
};

type CachedLatestRelease = {
  expiresAt: number;
  value: {
    version: string | null;
    url: string | null;
  };
};

const releaseCache = new Map<string, CachedLatestRelease>();
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function compareSemverLike(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10));

  if (leftParts.every(Number.isFinite) && rightParts.every(Number.isFinite)) {
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const leftValue = leftParts[index] ?? 0;
      const rightValue = rightParts[index] ?? 0;
      if (leftValue > rightValue) return 1;
      if (leftValue < rightValue) return -1;
    }
    return 0;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

async function fetchLatestRelease(upstreamRepo: string): Promise<{ version: string | null; url: string | null }> {
  const cached = releaseCache.get(upstreamRepo);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${upstreamRepo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "rivr-release-check",
      },
      signal: AbortSignal.timeout(3000),
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      const fallback = { version: null, url: `https://github.com/${upstreamRepo}` };
      releaseCache.set(upstreamRepo, {
        expiresAt: Date.now() + RELEASE_CACHE_TTL_MS,
        value: fallback,
      });
      return fallback;
    }

    const payload = (await response.json()) as { tag_name?: string; html_url?: string };
    const value = {
      version: normalizeVersion(payload.tag_name),
      url: payload.html_url ?? `https://github.com/${upstreamRepo}/releases`,
    };
    releaseCache.set(upstreamRepo, {
      expiresAt: Date.now() + RELEASE_CACHE_TTL_MS,
      value,
    });
    return value;
  } catch {
    const fallback = { version: null, url: `https://github.com/${upstreamRepo}` };
    releaseCache.set(upstreamRepo, {
      expiresAt: Date.now() + RELEASE_CACHE_TTL_MS,
      value: fallback,
    });
    return fallback;
  }
}

export async function buildAppReleaseStatus(defaults: AppReleaseDefaults): Promise<AppReleaseStatus> {
  const currentVersion =
    normalizeVersion(process.env.APP_VERSION) ||
    normalizeVersion(process.env.npm_package_version) ||
    defaults.defaultVersion;
  const upstreamRepo = process.env.APP_UPSTREAM_REPO || defaults.defaultUpstreamRepo;
  const releaseChannel = process.env.APP_RELEASE_CHANNEL || "dev";
  const deploymentUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || null;
  const currentCommit = process.env.GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null;
  const buildTime = process.env.APP_BUILD_TIME || null;

  const forcedLatestVersion = normalizeVersion(process.env.APP_LATEST_VERSION);
  const forcedLatestUrl = process.env.APP_LATEST_URL || null;
  const changelogUrl =
    process.env.APP_CHANGELOG_URL ||
    (upstreamRepo ? `https://github.com/${upstreamRepo}/releases` : null);

  const latestRelease =
    forcedLatestVersion || forcedLatestUrl
      ? { version: forcedLatestVersion, url: forcedLatestUrl || changelogUrl }
      : await fetchLatestRelease(upstreamRepo);

  const latestVersion = latestRelease.version;
  const updateAvailable =
    !!latestVersion && compareSemverLike(latestVersion, currentVersion) > 0;

  return {
    appName: defaults.appName,
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseChannel,
    deploymentUrl,
    upstreamRepo,
    latestUrl: latestRelease.url,
    changelogUrl,
    currentCommit,
    buildTime,
    checkedAt: new Date().toISOString(),
  };
}
