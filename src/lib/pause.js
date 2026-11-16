// Pause: nothing is recorded until a set time, then recording resumes on its
// own. A pause someone forgets about would silently lose their next real
// application, which is why there is no open-ended "off".
//
// The whole state is one number in settings, `pausedUntil` (ms since the
// epoch). The content script, the service worker and the popup each compare
// it with the clock at the moment they act, so a pause ends on time even
// when the alarm that tidies up after it (badge, title) runs late. An
// expired value is inert and is never cleaned up, so the service worker
// never writes settings and cannot race the popup's writes.
//
// capture.js repeats isPaused inline: a classic script cannot import this.

export const PAUSE_OPTIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
];

export const RESUME_ALARM = 'cc-resume';

export const isPaused = (settings, now = Date.now()) => Number(settings?.pausedUntil) > now;

// "3:45 PM". A pause lasts 8 hours at most, so the time alone is clear.
export const untilText = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
