/**
 * Start the Clawvato agent — CC-Native engine only.
 *
 * The hybrid agent code has been removed. All intelligence lives in brain-platform.
 * This file is kept for backward compatibility with the CLI `clawvato start` command.
 */

export { startCCNativeEngine as startAgent } from '../cc-native/start.js';
