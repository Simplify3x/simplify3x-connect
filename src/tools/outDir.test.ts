import { join, resolve } from 'node:path';
import { isLoopbackHost, resolveOutDir } from './outDir.js';

describe('resolveOutDir', () => {
  const cwd = resolve('/srv/mcp');
  const base = join(cwd, 'qa-reports');

  it('defaults to <cwd>/qa-reports', () => {
    expect(resolveOutDir(undefined, true, cwd)).toEqual({ dir: base });
    expect(resolveOutDir(undefined, false, cwd)).toEqual({ dir: base });
    expect(resolveOutDir('  ', true, cwd)).toEqual({ dir: base });
  });

  it('local server: honours the caller folder, made absolute', () => {
    expect(resolveOutDir('out/x', true, cwd)).toEqual({ dir: resolve(cwd, 'out/x') });
    const abs = resolve('/tmp/reports');
    expect(resolveOutDir(abs, true, cwd)).toEqual({ dir: abs });
  });

  it('local server: refuses network (UNC) paths and NUL bytes', () => {
    expect(() => resolveOutDir('\\\\evil\\share', true, cwd)).toThrow(/network/);
    expect(() => resolveOutDir('//evil/share', true, cwd)).toThrow(/network/);
    expect(() => resolveOutDir('a\0b', true, cwd)).toThrow(/invalid/);
  });

  it('remote server: ignores the caller folder and says so', () => {
    for (const p of ['/etc', '../../x', '\\\\evil\\share', 'C:\\Windows']) {
      const r = resolveOutDir(p, false, cwd);
      expect(r.dir).toBe(base);
      expect(r.note).toMatch(/outDir was ignored/);
    }
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5', ' LOCALHOST '])('%s is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  it.each(['0.0.0.0', '::', '10.0.0.4', 'mcp.example.com', ''])('%s is not loopback', (h) => expect(isLoopbackHost(h)).toBe(false));
});
