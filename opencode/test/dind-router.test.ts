import { describe, expect, it } from 'bun:test';
import {
  buildContainerName,
  buildDockerExecCommand,
  mapHostPathToContainer,
  sanitizeContainerName,
} from '../plugin/dind-router';

describe('dind router helpers', () => {
  it('sanitizes container names safely', () => {
    expect(sanitizeContainerName('My/Container#1')).toBe('my-container-1');
    expect(sanitizeContainerName('$$$')).toBe('opencode');
    expect(sanitizeContainerName(undefined as unknown as string)).toBe(
      'opencode',
    );
    expect(sanitizeContainerName(123 as unknown as string)).toBe('123');
  });

  it('builds a stable container name with prefix and ids', () => {
    const name = buildContainerName('OpenCode', 'abcdef1234567890', 'session-xyz');
    expect(name).toBe('opencode-abcdef12-session');
  });

  it('maps host paths to container workdir', () => {
    expect(
      mapHostPathToContainer('/repo/packages/app', '/repo', '/workspace'),
    ).toBe('/workspace/packages/app');
    expect(mapHostPathToContainer('packages/app', '/repo', '/workspace')).toBe(
      '/workspace/packages/app',
    );
    expect(mapHostPathToContainer('/outside', '/repo', '/workspace')).toBe(
      '/workspace',
    );
    expect(
      mapHostPathToContainer(undefined as unknown as string, '/repo', '/workspace'),
    ).toBe('/workspace');
    expect(
      mapHostPathToContainer('packages/app', undefined as unknown as string, '/workspace'),
    ).toBe('/workspace');
  });

  it('builds docker exec command with workdir and env', () => {
    const command = buildDockerExecCommand({
      dockerBinary: 'docker',
      container: 'devbox',
      command: 'ls -la',
      workdir: '/workspace/app',
      env: { NODE_ENV: 'test' },
    });

    expect(command).toContain('docker exec');
    expect(command).toContain('--workdir "/workspace/app"');
    expect(command).toContain('-e "NODE_ENV=test"');
    expect(command).toContain('devbox');
    expect(command).toContain('sh -lc "ls -la"');
  });

  it('returns a failure command when exec arguments are missing', () => {
    const missingContainer = buildDockerExecCommand({
      dockerBinary: 'docker',
      container: undefined as unknown as string,
      command: 'ls -la',
    });
    const missingCommand = buildDockerExecCommand({
      dockerBinary: 'docker',
      container: 'devbox',
      command: undefined as unknown as string,
    });

    expect(missingContainer).toContain('DIND routing failed');
    expect(missingContainer).toContain('exit 1');
    expect(missingCommand).toContain('DIND routing failed');
  });
});
