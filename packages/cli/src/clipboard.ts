/** Copies text with whichever system clipboard tool exists. Returns false when none works. */
import { spawn } from 'node:child_process';

const TOOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['pbcopy', []],
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
];

const TOOL_TIMEOUT_MS = 3000;

// Executor-style Promise on purpose: the bundle must run on Node 20, which lacks Promise.withResolvers.
function tryTool(
  cmd: string,
  args: readonly string[],
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    // Every failure path kills the helper: a stuck one must not keep the CLI (or `$(ntn-link ...)`) alive
    // after the link is printed. SIGKILL because a helper that ignores SIGTERM is exactly the stuck case.
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) child.kill('SIGKILL');
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.on('error', () => finish(false)); // ENOENT: tool not installed
    child.on('close', (code) => finish(code === 0));
    child.stdin.on('error', () => finish(false));
    child.stdin.end(text);
  });
}

export async function copyToClipboard(text: string, timeoutMs = TOOL_TIMEOUT_MS): Promise<boolean> {
  for (const [cmd, args] of TOOLS) {
    if (await tryTool(cmd, args, text, timeoutMs)) return true;
  }
  return false;
}
