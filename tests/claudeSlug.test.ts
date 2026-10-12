import { describe, expect, it } from 'vitest';
import {
  clearProjectSlugCache, projectSlugFromPath, resolveProjectSlug, resolveProjectSlugCached,
  slugifyProjectName,
} from '../src/sources/claudeSlug.ts';

/**
 * Recovering a Claude project directory from its `projects/<slug>/` folder name.
 *
 * The encoding replaces EVERY non-alphanumeric with one dash, so it is not reversible by
 * string surgery: `NEW_CODE` and `NEW/CODE` both encode to `NEW-CODE`, and `03_调研报告`
 * becomes `03-----`. Naive `-`→`/` decoding produced paths that do not exist for 8 of the 11
 * slugs measured on this machine. The resolver therefore treats the slug as a search key and
 * confirms each component against a directory listing.
 *
 * A virtual filesystem is injected so these tests pin the algorithm, not the machine.
 */

/** Build a `readdir` over a literal tree. Keys are absolute directory paths. */
function vfs(tree: Record<string, string[]>) {
  return (dir: string): string[] => {
    if (!(dir in tree)) throw new Error('ENOENT ' + dir);
    return tree[dir];
  };
}

describe('slugifyProjectName', () => {
  it('replaces each non-alphanumeric with exactly one dash', () => {
    expect(slugifyProjectName('NEW_CODE')).toBe('NEW-CODE');
    expect(slugifyProjectName('03_调研报告')).toBe('03-----'); // 1 underscore + 4 chars
    expect(slugifyProjectName('a.b-c_d')).toBe('a-b-c-d');
  });

  it('leaves alphanumerics untouched', () => {
    expect(slugifyProjectName('MainAgentTool42')).toBe('MainAgentTool42');
  });
});

describe('projectSlugFromPath', () => {
  it('reads the project folder out of a session path', () => {
    expect(projectSlugFromPath('/home/u/.claude/projects/-media-vdc-NEW-CODE/s.jsonl'))
      .toBe('-media-vdc-NEW-CODE');
  });

  it('returns undefined when there is no projects component', () => {
    expect(projectSlugFromPath('/tmp/s.jsonl')).toBeUndefined();
  });
});

describe('resolveProjectSlug', () => {
  const tree = {
    '/': ['media', 'home', 'tmp'],
    '/media': ['vdc'],
    '/media/vdc': ['NEW_CODE', 'NEW_WORK'],
    '/media/vdc/NEW_CODE': ['test', 'MainAgentTool'],
    '/media/vdc/NEW_CODE/test': ['check_completion_tokens2', 'obsidian_tool'],
    '/media/vdc/NEW_WORK': ['03_调研报告'],
  };

  it('resolves a path containing an underscore', () => {
    // `NEW_CODE` encodes to `NEW-CODE`; naive decoding would look for `/media/vdc/NEW/CODE`.
    expect(resolveProjectSlug('-media-vdc-NEW-CODE', vfs(tree)))
      .toBe('/media/vdc/NEW_CODE');
  });

  it('resolves a path containing a hyphen next to an underscore', () => {
    expect(resolveProjectSlug('-media-vdc-NEW-CODE-test-check-completion-tokens2', vfs(tree)))
      .toBe('/media/vdc/NEW_CODE/test/check_completion_tokens2');
  });

  /**
   * The case that defeats decoding outright: four Chinese characters and an underscore all
   * collapse to the same five dashes. Only the directory listing can tell them apart.
   */
  it('resolves a directory whose name is non-ASCII', () => {
    expect(resolveProjectSlug('-media-vdc-NEW-WORK-03-----', vfs(tree)))
      .toBe('/media/vdc/NEW_WORK/03_调研报告');
  });

  it('resolves the bare root of a project', () => {
    expect(resolveProjectSlug('-media-vdc', vfs(tree))).toBe('/media/vdc');
  });

  /**
   * `NEW_CODE` encodes to `NEW-CODE`, which also starts with the encoding of a shorter
   * sibling `NEW`. Longest-name-first ordering is what stops it descending into the wrong
   * branch and losing the rest of the path.
   */
  it('prefers a longer sibling name over a shorter prefix of it', () => {
    const t = { '/': ['media'], '/media': ['NEW', 'NEW_CODE'], '/media/NEW_CODE': ['x'] };
    expect(resolveProjectSlug('-media-NEW-CODE-x', vfs(t))).toBe('/media/NEW_CODE/x');
  });

  it('returns undefined when a component does not exist', () => {
    // The directory was moved or deleted: the caller must see "unknown", never a guess.
    expect(resolveProjectSlug('-media-vdc-NOPE', vfs(tree))).toBeUndefined();
  });

  it('returns undefined for a slug that does not start with a dash', () => {
    expect(resolveProjectSlug('media-vdc', vfs(tree))).toBeUndefined();
  });

  it('returns undefined rather than looping when the tree is cyclic', () => {
    const cyclic = { '/a': ['a'] }; // /a/a would recurse forever without the depth cap
    expect(resolveProjectSlug('-a-a-a-a-a-a-a-a', vfs({ ...cyclic, '/a/a': ['a'] }))).toBeUndefined();
  });

  it('ignores entries that encode to an empty string', () => {
    const t = { '/': ['media', '___'], '/media': ['vdc'] };
    expect(resolveProjectSlug('-media-vdc', vfs(t))).toBe('/media/vdc');
  });
});

describe('resolveProjectSlugCached', () => {
  const tree = { '/': ['media'], '/media': ['NEW_CODE'] };

  /** `discover()` sees one slug across every session in a project, so the walk must run once. */
  it('walks the filesystem only on the first lookup of a slug', () => {
    clearProjectSlugCache();
    let dirsRead = 0;
    const counting = (dir: string) => { dirsRead++; return vfs(tree)(dir); };

    const first = resolveProjectSlugCached('-media-NEW-CODE', counting);
    const readsAfterFirst = dirsRead;
    const second = resolveProjectSlugCached('-media-NEW-CODE', counting);

    expect(first).toBe('/media/NEW_CODE');
    expect(second).toBe('/media/NEW_CODE');
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(dirsRead, 'second lookup must be served from cache').toBe(readsAfterFirst);
    clearProjectSlugCache();
  });

  /** A miss must NOT be cached: the directory may be restored while the process lives. */
  it('does not cache a miss, so a restored directory is picked up', () => {
    clearProjectSlugCache();
    const missing = vfs({ '/': ['media'] });
    expect(resolveProjectSlugCached('-media-NEW-CODE', missing)).toBeUndefined();
    // The directory now exists; the cache must not have remembered the failure.
    expect(resolveProjectSlugCached('-media-NEW-CODE', vfs(tree))).toBe('/media/NEW_CODE');
    clearProjectSlugCache();
  });
});