/** Isolated-world content script entry. */
import { startRelay } from './relay';

startRelay(window, (message) => chrome.runtime.sendMessage(message));
