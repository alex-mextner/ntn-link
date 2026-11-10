/** Child process: one key save with a short lock wait; prints "saved" or the error message. */
import { openKeyStore } from '../src/keys';

const [path, waitMs] = process.argv.slice(2);
if (path === undefined || waitMs === undefined)
  throw new Error('usage: lock-probe <path> <waitMs>');
try {
  openKeyStore(path, { lockWaitMs: Number(waitMs) }).set('https://svc.test', 'ws', 'key');
  console.log('saved');
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
