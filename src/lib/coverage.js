// Is a frame somewhere Carbon Copy may record? Either the manifest's own
// content-script matches (the presets, plus localhost in the test build) or
// a site granted with "Record this site" and not since stopped.
//
// Checked against the manifest, not only the live permission set, because a
// user in Chrome's "on click" site-access mode grants a preset site through
// activeTab, which permissions.contains() never reports.

import { matchesPattern } from '../presets/jobs.js';

// The pattern "Record this site" requests: scheme and hostname, no port.
export const sitePattern = u => `${u.protocol}//${u.hostname}/*`;

// contains: pattern -> Promise<boolean>, chrome.permissions.contains in the
// service worker, a stub in the unit tests.
export async function isCovered(url, staticMatches, contains) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (staticMatches.some(p => matchesPattern(p, u.href))) return true;
  return !!(await contains(sitePattern(u)));
}
