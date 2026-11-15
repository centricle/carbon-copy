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

// Granted patterns that name a site. Chrome's "On all sites" site access
// grants the whole optional_host_permissions pattern (https://*/*), and that
// is not a site anyone chose to record: banking and mail would get the
// content script too. So a host of "*", or "*." over a single label
// ("*.com"), never counts, and neither does <all_urls>. Recording stays
// limited to sites added one at a time.
export function concreteOrigins(origins = []) {
  return origins.filter(o => {
    const m = /^[a-z*]+:\/\/([^/]+)\//i.exec(o);
    return !!m && m[1] !== '*' && !/^\*\.[^.]+$/.test(m[1]);
  });
}

// contains: pattern -> Promise<boolean>, an exact concrete grant in the
// service worker (isGranted), a stub in the unit tests.
export async function isCovered(url, staticMatches, contains) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (staticMatches.some(p => matchesPattern(p, u.href))) return true;
  return !!(await contains(sitePattern(u)));
}
