/** Child process for the concurrency test: saves one key, as a parallel CLI run would. */
import { openKeyStore } from '../src/keys';

const [path, origin, ws, key] = process.argv.slice(2);
if (path === undefined || origin === undefined || ws === undefined || key === undefined) {
  throw new Error('usage: key-writer <path> <origin> <ws> <key>');
}
openKeyStore(path).set(origin, ws, key);
