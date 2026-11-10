import { MemoryStore } from '../src/memory-store';
import { defineStoreContract } from './store-contract';

defineStoreContract('MemoryStore', () => {
  let offsetMs = 0;
  return {
    store: new MemoryStore(() => Date.now() + offsetMs),
    advanceSeconds: async (seconds) => {
      offsetMs += seconds * 1000;
    },
  };
});
