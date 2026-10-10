/** Numeric parts of a version like "v0.3.5" or "0.3.5-beta" → [0, 3, 5]. */
function versionParts(version: string): number[] {
  return version.replace(/^v/i, '').split(/[.-]/).map((part) => parseInt(part, 10) || 0);
}

/**
 * True when an agent update should be offered: only if the installed version is
 * older than the one the server ships. A newer installed agent (e.g. after the
 * server rolled back its agent version) is never "updated" to an older one.
 */
export function isAgentOutdated(installed?: string | null, latest?: string | null): boolean {
  if (!installed || !latest) return false;
  const a = versionParts(installed);
  const b = versionParts(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}
