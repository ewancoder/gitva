import type { en } from './languages/en.js';

/**
 * Strings type is based on English language type,
 * so that other languages are REQUIRED to have all the same fields.
 */
export type Strings = typeof en;
