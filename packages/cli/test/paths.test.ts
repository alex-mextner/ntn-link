import { expect, test } from 'bun:test';
import { ConfigError, keysFilePath } from '../src/paths';

test('XDG_CONFIG_HOME wins, else ~/.config', () => {
  expect(keysFilePath({ XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/ntn-link/keys.json');
  expect(keysFilePath({}, '/h')).toBe('/h/.config/ntn-link/keys.json');
});

test('a relative XDG_CONFIG_HOME is ignored per the XDG spec', () => {
  expect(keysFilePath({ XDG_CONFIG_HOME: 'rel' }, '/h')).toBe('/h/.config/ntn-link/keys.json');
});

test('no usable location is a config error', () => {
  expect(() => keysFilePath({}, undefined)).toThrow(ConfigError);
  expect(() => keysFilePath({}, '')).toThrow(ConfigError);
});
