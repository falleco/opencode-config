import { describe, expect, it } from 'bun:test';
import { formatWorktreeLog } from '../plugin/worktree';

describe('worktree log formatting', () => {
  it('formats action with sorted details', () => {
    const line = formatWorktreeLog('create.start', {
      branch: 'feature/foo',
      base: 'main',
    });

    expect(line).toBe('[worktree] create.start base=main branch=feature/foo');
  });

  it('omits empty values', () => {
    const line = formatWorktreeLog('delete.done', {
      branch: 'cleanup',
      path: '',
      session: undefined,
    });

    expect(line).toBe('[worktree] delete.done branch=cleanup');
  });

  it('handles undefined details', () => {
    const line = formatWorktreeLog('create.start', undefined as unknown as Record<
      string,
      string | undefined
    >);

    expect(line).toBe('[worktree] create.start');
  });
});
