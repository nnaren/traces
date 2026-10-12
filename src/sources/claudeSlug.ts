/**
 * Recover a Claude Code session's project directory from its `projects/<slug>/` name.
 *
 * Claude Code names the project folder after the launch directory with EVERY character
 * outside `[A-Za-z0-9]` replaced by `-`, one for one:
 *
 *   /media/vdc/NEW_CODE/MainAgentTool/hestia  →  -media-vdc-NEW-CODE-MainAgentTool-hestia
 *   /media/vdc/NEW_WORK/03_调研报告            →  -media-vdc-NEW-WORK-03-----
 *
 * That is lossy in the obvious direction and the slug alone is NOT reversible — naive
 * `-`→`/` decoding gets `NEW-CODE` back as the two directories `NEW` and `CODE`, which is
 * how 8 of 11 slugs on this machine decoded to paths that do not exist. The non-ASCII case is
 * worse: four Chinese characters and an underscore all collapse into five identical dashes.
 *
 * So the slug is treated as a SEARCH KEY rather than an encoding: at each level the real
 * directory is listed and every entry is re-encoded with the same rule, and the one whose
 * encoded form is a prefix of what remains wins. Nothing is guessed — a component is only
 * accepted because the filesystem confirms it — and the four-dash run resolves to
 * `03_调研报告` because that is the only entry there that encodes to `03-----`.
 *
 * Cost is one `readdir` per path component, memoised per slug because `discover()` sees the
 * same handful of slugs across every session in a project.
 */

/** Claude Code's name encoding: each non-alphanumeric becomes one dash. */
import { readdirSync } from 'node:fs';

export function slugifyProjectName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-');
}

/** Depth cap: guards against a symlink loop turning resolution into an infinite walk. */
const MAX_DEPTH = 32;

/**
 * Resolve a Claude project slug to a real directory.
 *
 * Returns `undefined` when the directory no longer exists (the project was moved or deleted)
 * — the caller must treat that as "unknown", never as "the slug looks like a path".
 * `readdir` is injectable so the walk can be tested without a real filesystem.
 */
export function resolveProjectSlug(
  slug: string,
  readdir: (dir: string) => string[] = defaultReaddir,
): string | undefined {
  // A slug always starts with the dash that replaced the leading `/`.
  if (!slug.startsWith('-')) return undefined;
  const rest = slug.slice(1);

  const walk = (prefix: string, remaining: string, depth: number): string | undefined => {
    if (remaining === '') return prefix;
    if (depth > MAX_DEPTH) return undefined;
    let entries: string[];
    try { entries = readdir(prefix); } catch { return undefined; }

    // Longest name first: an exact full match should win over a shorter prefix that merely
    // happens to sit beside it (e.g. `NEW` next to `NEW_CODE`).
    for (const name of [...entries].sort((a, b) => b.length - a.length)) {
      const encoded = slugifyProjectName(name);
      if (!encoded) continue;
      // The remainder must be exactly this component, or this component plus a separator.
      if (remaining === encoded) return joinPath(prefix, name);
      if (remaining.startsWith(encoded) && remaining[encoded.length] === '-') {
        const found = walk(joinPath(prefix, name), remaining.slice(encoded.length + 1), depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };

  return walk('/', rest, 0);
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

function defaultReaddir(dir: string): string[] {
  // A static import, NOT `require`: this project is ESM ("type": "module"), where `require`
  // is undefined. A lazy `require` here silently threw, the walk's own try/catch swallowed
  // it, and every slug resolved to "not found" — a total, silent loss of the feature that
  // only showed up under a real ESM load (an ad-hoc `tsx -e` shims `require` and passes).
  return readdirSync(dir);
}

/** Extracts the `projects/<slug>` component from a Claude session path, if it has one. */
export function projectSlugFromPath(p: string): string | undefined {
  const m = /(?:^|[/\\])projects[/\\]([^/\\]+)[/\\]/.exec(p);
  return m ? m[1] : undefined;
}

/**
 * Memoised resolver — the same slug recurs across every session in one project, and each
 * resolution costs one `readdir` per path component.
 *
 * Only successful resolutions are cached. An unresolvable slug means the directory is gone,
 * but the process may be long-lived while the user restores it, so a miss is retried rather
 * than remembered as permanent.
 */
const cache = new Map<string, string>();

export function resolveProjectSlugCached(
  slug: string,
  readdir: (dir: string) => string[] = defaultReaddir,
): string | undefined {
  const hit = cache.get(slug);
  if (hit !== undefined) return hit;
  const resolved = resolveProjectSlug(slug, readdir);
  if (resolved !== undefined) cache.set(slug, resolved);
  return resolved;
}

/** Test seam. */
export function clearProjectSlugCache(): void {
  cache.clear();
}