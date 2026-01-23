import { describe, expect, it } from 'bun:test';
import {
  buildContainerName,
  buildDockerExecCommand,
  buildGrepCommand,
  buildGlobCommand,
  buildListCommand,
  buildReadCommand,
  formatCommandForLog,
  mapContainerPathToHost,
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

  it('maps container paths back to host', () => {
    expect(
      mapContainerPathToHost('/workspace/packages/app', '/repo', '/workspace'),
    ).toBe('/repo/packages/app');
    expect(
      mapContainerPathToHost('packages/app', '/repo', '/workspace'),
    ).toBe('/repo/packages/app');
    expect(
      mapContainerPathToHost('/outside', '/repo', '/workspace'),
    ).toBe('/repo');
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

  it('formats intercepted commands for logs', () => {
    const short = formatCommandForLog('ls -la', 10);
    const long = formatCommandForLog('a'.repeat(50), 10);
    const empty = formatCommandForLog(undefined as unknown as string, 10);

    expect(short).toBe('ls -la');
    expect(long).toBe('aaaaaaaaaa...');
    expect(empty).toBe('');
  });

  it('builds a safe read command', () => {
    const command = buildReadCommand('/workspace/app/file.ts');
    expect(command).toBe('cat -- "/workspace/app/file.ts"');
  });

  it('builds a safe glob command', () => {
    const command = buildGlobCommand('*.ts', 25);
    expect(command).toBe('rg --files -g "*.ts" 2>/dev/null | head -n 25');
  });

  it('builds a safe list command', () => {
    const command = buildListCommand('/workspace/app', 50);
    expect(command).toBe(
      'ls -A -p -1 -- "/workspace/app" 2>/dev/null | head -n 50',
    );
  });

  it('builds a safe grep command', () => {
    const command = buildGrepCommand('TODO', '*.ts');
    expect(command).toBe(
      'rg -nH --field-match-separator=| --regexp "TODO" --glob "*.ts" 2>/dev/null',
    );
  });
});
