/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { forgetKey, keyName, loadKey, saveKey, storedWorkspaces } from '../../lib/client/keys';
import { MemoryStorage } from './helpers';

describe('owner key storage', () => {
  test('is keyed by origin and workspace', () => {
    const storage = new MemoryStorage();
    saveKey(storage, 'https://a.test', 'thsm', 'KEY-A');
    saveKey(storage, 'https://b.test', 'thsm', 'KEY-B');
    saveKey(storage, 'https://a.test', 'other', 'KEY-O');
    expect(loadKey(storage, 'https://a.test', 'thsm')).toBe('KEY-A');
    expect(loadKey(storage, 'https://b.test', 'thsm')).toBe('KEY-B');
    expect(loadKey(storage, 'https://a.test', 'other')).toBe('KEY-O');
    expect(loadKey(storage, 'https://c.test', 'thsm')).toBeNull();
  });

  test('origins that are prefixes of each other do not collide', () => {
    const storage = new MemoryStorage();
    saveKey(storage, 'https://a.test', 'x', 'K1');
    expect(loadKey(storage, 'https://a.test:8080', 'x')).toBeNull();
    expect(storedWorkspaces(storage, 'https://a.test:8080')).toEqual([]);
  });

  test('lists only workspaces of this origin', () => {
    const storage = new MemoryStorage();
    saveKey(storage, 'https://a.test', 'zeta', 'K');
    saveKey(storage, 'https://a.test', 'alpha', 'K');
    saveKey(storage, 'https://b.test', 'beta', 'K');
    storage.setItem('unrelated', 'x');
    expect(storedWorkspaces(storage, 'https://a.test')).toEqual(['alpha', 'zeta']);
  });

  test('forget removes only that workspace', () => {
    const storage = new MemoryStorage();
    saveKey(storage, 'https://a.test', 'x', 'K1');
    saveKey(storage, 'https://a.test', 'y', 'K2');
    forgetKey(storage, 'https://a.test', 'x');
    expect(loadKey(storage, 'https://a.test', 'x')).toBeNull();
    expect(loadKey(storage, 'https://a.test', 'y')).toBe('K2');
  });

  test('a refusing or missing storage never throws and reports failure', () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    expect(saveKey(storage, 'https://a.test', 'x', 'K')).toBe(false);
    expect(saveKey(null, 'https://a.test', 'x', 'K')).toBe(false);
    expect(loadKey(null, 'https://a.test', 'x')).toBeNull();
    expect(() => forgetKey(null, 'https://a.test', 'x')).not.toThrow();
    expect(keyName('https://a.test', 'x')).toContain('https://a.test');
  });
});
