import { describe, expect, test } from 'bun:test';
import { UsageError, parseArgs } from '../src/args';

const URL_ARG = 'https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9';

describe('parseArgs', () => {
  test('create with flags', () => {
    const { command } = parseArgs([URL_ARG, '--slug', 'our-trips', '--fast', '--copy'], {});
    expect(command).toEqual({
      kind: 'create',
      url: URL_ARG,
      slug: 'our-trips',
      fast: true,
      copy: true,
    });
  });

  test('flags may come before the url and use = form', () => {
    const { command } = parseArgs(['--slug=a-b', URL_ARG], {});
    expect(command).toEqual({
      kind: 'create',
      url: URL_ARG,
      slug: 'a-b',
      fast: false,
      copy: false,
    });
  });

  test('subcommands', () => {
    expect(parseArgs(['ls', 'thsm'], {}).command).toEqual({ kind: 'ls', ws: 'thsm' });
    expect(parseArgs(['rm', 'thsm/our-trips'], {}).command).toEqual({
      kind: 'rm',
      target: 'thsm/our-trips',
    });
    expect(
      parseArgs(['set', 'thsm/our-trips', '--title', 'Hi', '--fast', 'off'], {}).command,
    ).toEqual({
      kind: 'set',
      target: 'thsm/our-trips',
      title: 'Hi',
      fast: false,
    });
  });

  test('set accepts every editable field', () => {
    const { command } = parseArgs(
      ['set', 'a/b', '--description', 'd', '--slug', 'c', '--fast', 'on', '--canonical', 'notion'],
      {},
    );
    expect(command).toMatchObject({
      description: 'd',
      slug: 'c',
      fast: true,
      canonicalMode: 'notion',
    });
  });

  test.each([
    [[]],
    [['--nope']],
    [[URL_ARG, '--bogus']],
    [['rm', 'thsm']],
    [['rm', 'a/b/c']],
    [['ls']],
    [['ls', 'a/b']],
    [['set', 'a/b']],
    [['set', 'a/b', '--fast', 'maybe']],
    [['set', 'a/b', '--canonical', 'x']],
    [[URL_ARG, '--slug']],
    [[URL_ARG, 'second']],
    [['ls', 'thsm', '--copy']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv, {})).toThrow(UsageError);
  });

  test('global options may come before the verb, for every verb', () => {
    expect(parseArgs(['--origin', 'https://x.test', 'set', 'a/b', '--title', 'Hi'], {})).toEqual({
      command: { kind: 'set', target: 'a/b', title: 'Hi' },
      origin: 'https://x.test',
    });
    expect(parseArgs(['--origin', 'https://x.test', 'ls', 'thsm'], {}).command).toEqual({
      kind: 'ls',
      ws: 'thsm',
    });
    expect(parseArgs(['--origin', 'https://x.test', 'rm', 'a/b'], {}).command).toEqual({
      kind: 'rm',
      target: 'a/b',
    });
    expect(parseArgs(['--fast', 'on', 'set', 'a/b'], {}).command).toMatchObject({
      kind: 'set',
      fast: true,
    });
  });

  test('--fast is a switch for create and takes on|off for set, in both option positions', () => {
    expect(() => parseArgs(['set', 'a/b', '--fast'], {})).toThrow(UsageError);
    expect(() => parseArgs([URL_ARG, '--fast', 'on'], {})).toThrow(UsageError);
    expect(() => parseArgs(['ls', 'thsm', '--fast'], {})).toThrow(UsageError);
    expect(parseArgs(['--fast', URL_ARG], {}).command).toMatchObject({
      kind: 'create',
      fast: true,
    });
  });

  test('help and version', () => {
    expect(parseArgs(['--help'], {}).command.kind).toBe('help');
    expect(parseArgs(['-v'], {}).command.kind).toBe('version');
  });

  test('origin: flag beats env beats default', () => {
    const flagged = parseArgs([URL_ARG, '--origin', 'http://localhost:3000'], {
      NTN_LINK_ORIGIN: 'https://env.example',
    });
    expect(flagged.origin).toBe('http://localhost:3000');
    expect(parseArgs([URL_ARG], { NTN_LINK_ORIGIN: 'https://env.example/' }).origin).toBe(
      'https://env.example',
    );
    expect(parseArgs([URL_ARG], {}).origin).toBe('https://ntn-link.vercel.app');
  });

  test('refuses to send the owner key over plain http to a remote host', () => {
    expect(() => parseArgs([URL_ARG, '--origin', 'http://example.com'], {})).toThrow(UsageError);
    expect(() => parseArgs([URL_ARG, '--origin', 'not a url'], {})).toThrow(UsageError);
  });
});

describe('missing option values', () => {
  test('an option token is never swallowed as a value', () => {
    expect(() => parseArgs(['set', 'a/b', '--title', '--description', 'x'], {})).toThrow(
      UsageError,
    );
    expect(parseArgs(['set', 'a/b', '--title=--literal'], {}).command).toMatchObject({
      title: '--literal',
    });
  });
});
