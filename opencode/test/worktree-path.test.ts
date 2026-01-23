import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getProjectId } from '../plugin/kdco-primitives/get-project-id';
import { getWorktreePath } from '../plugin/worktree/state';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe('worktree path', () => {
  it('uses default base when none provided', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocx-worktree-'));
    tempDirs.push(root);

    const projectId = await getProjectId(root);
    const result = await getWorktreePath(root, 'feature/test');

    expect(result).toBe(
      path.join(
        os.homedir(),
        '.local',
        'share',
        'opencode',
        'worktree',
        projectId,
        'feature/test',
      ),
    );
  });

  it('resolves a relative base directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocx-worktree-'));
    tempDirs.push(root);

    const projectId = await getProjectId(root);
    const result = await getWorktreePath(root, 'feature/test', '.worktrees');

    expect(result).toBe(
      path.join(root, '.worktrees', projectId, 'feature/test'),
    );
  });

  it('uses an absolute base directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocx-worktree-'));
    tempDirs.push(root);

    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ocx-base-'));
    tempDirs.push(base);

    const projectId = await getProjectId(root);
    const result = await getWorktreePath(root, 'feature/test', base);

    expect(result).toBe(path.join(base, projectId, 'feature/test'));
  });
});
