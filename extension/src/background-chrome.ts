/** Chrome service-worker entry. */
import { startBackground } from './background-main';
import { copyViaOffscreen } from './clipboard-chrome';

startBackground(copyViaOffscreen);
