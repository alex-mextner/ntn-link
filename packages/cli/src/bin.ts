#!/usr/bin/env node
/** Process entry: wires the real world into run(). */
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { copyToClipboard } from './clipboard';
import { EXIT, Fail } from './errors';
import { type Io, run } from './run';

function ask(question: string): Promise<string> {
  // The question goes to stderr so stdout stays clean for the link.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Executor-style Promise on purpose: the bundle must run on Node 20, which lacks Promise.withResolvers.
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    // Ctrl-C or EOF closes the interface without an answer: abort instead of verifying.
    rl.on('close', () => {
      if (!answered) reject(new Fail('Aborted.', EXIT.failure));
    });
  });
}

const io: Io = {
  fetch: (url, init) => fetch(url, init),
  env: process.env,
  home: process.env['HOME'] ?? homedir(),
  tmp: tmpdir(),
  now: () => new Date(),
  pid: process.pid,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  ask,
  copy: copyToClipboard,
};

process.exitCode = await run(process.argv.slice(2), io);
