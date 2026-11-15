// Job-search preset: the hosts Carbon Copy records on without being asked,
// and how to read a company and a role out of each one's URLs.
//
// MATCHES must equal content_scripts[0].matches in manifest.json. The unit
// test checks that, so the two cannot drift apart.

export const MATCHES = [
  'https://*.greenhouse.io/*',
  'https://jobs.lever.co/*',
  'https://jobs.ashbyhq.com/*',
  'https://*.myworkdayjobs.com/*',
  'https://apply.workable.com/*',
  'https://jobs.smartrecruiters.com/*',
  'https://*.icims.com/*',
  'https://*.bamboohr.com/*',
  'https://*.upwork.com/*',
  'https://*.toptal.com/*',
  'https://wellfound.com/*',
  'https://contra.com/*',
  'https://*.usebraintrust.com/*',
];

// Does a Chrome match pattern ("https://*.example.com/*") cover this URL?
// Enough of the grammar for the patterns this extension uses: scheme, an
// optional leading "*." on the host, and a path glob.
export function matchesPattern(pattern, url) {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/*]+)(\/.*)$/.exec(pattern);
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!m) return false;
  const [, scheme, host, path] = m;
  if (scheme !== '*' && `${scheme}:` !== u.protocol) return false;
  if (scheme === '*' && !/^https?:$/.test(u.protocol)) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
    } else if (u.hostname !== host) return false;
  }
  const re = new RegExp(`^${path.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(u.pathname + u.search);
}

export const isPresetUrl = url => MATCHES.some(p => matchesPattern(p, url));

// Each rule: a host test, and a function from (URL, meta) to a partial
// context. Path segments are slugs ("acme-corp"); the page's own title is
// tried first when it states the company in a known shape.
const RULES = [
  {
    host: /(^|\.)greenhouse\.io$/,
    read(u, meta) {
      const seg = u.pathname.split('/').filter(Boolean);
      // /embed/job_app?for=<co>&token=<id> (iframe on the employer's site)
      let company = u.searchParams.get('for') || (seg[0] !== 'embed' ? seg[0] : null);
      let role = null;
      // og:title "Job Application for <role> at <company>"
      const m = /^Job Application for (.+?) at (.+)$/i.exec(meta.ogTitle || meta.title || '');
      if (m) { role = m[1]; company = m[2]; }
      return { company, role };
    },
  },
  {
    host: /^jobs\.lever\.co$/,
    read(u, meta) {
      const seg = u.pathname.split('/').filter(Boolean);
      // og:title "<company> - <role>"
      const m = /^(.+?) - (.+)$/.exec(meta.ogTitle || meta.title || '');
      return m ? { company: m[1], role: m[2] } : { company: seg[0] };
    },
  },
  {
    host: /^jobs\.ashbyhq\.com$/,
    read(u) { return { company: u.pathname.split('/').filter(Boolean)[0] }; },
  },
  {
    // <co>.wd5.myworkdayjobs.com
    host: /^([^.]+)\.wd\d+\.myworkdayjobs\.com$/,
    read(u) { return { company: u.hostname.split('.')[0] }; },
  },
  {
    host: /^apply\.workable\.com$/,
    read(u) { return { company: u.pathname.split('/').filter(Boolean)[0] }; },
  },
  {
    // /<Company>/<id>-<role-slug>
    host: /^jobs\.smartrecruiters\.com$/,
    read(u) {
      const seg = u.pathname.split('/').filter(Boolean);
      const role = seg[1] ? seg[1].replace(/^\d+-?/, '').replace(/-/g, ' ') : null;
      return { company: seg[0], role: role || null };
    },
  },
  {
    // <co>.bamboohr.com, careers-<co>.icims.com
    host: /^([^.]+)\.(bamboohr|icims)\.com$/,
    read(u) { return { company: u.hostname.split('.')[0].replace(/^careers-|-careers$/g, '') }; },
  },
];

function clean(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : null;
}

// url: the page (top-level) URL when known, else the frame URL.
// meta: { title, ogTitle, ogSiteName, h1 } from the content script.
export function extractContext(url, meta = {}, frameUrl = null) {
  const out = { company: null, role: null, preset: null };
  const candidates = [url, frameUrl].filter(Boolean);
  for (const raw of candidates) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    const rule = RULES.find(r => r.host.test(u.hostname));
    if (!rule) continue;
    const got = rule.read(u, meta);
    out.company = clean(got.company);
    out.role = clean(got.role);
    out.preset = 'jobs';
    break;
  }
  // Fallbacks: the role from the page, the company from the site name or host.
  out.role = out.role || clean(meta.h1) || clean(meta.ogTitle) || clean(meta.title);
  if (!out.company) {
    let host = null;
    try { host = new URL(url || frameUrl).hostname.replace(/^www\./, ''); } catch { /* none */ }
    out.company = clean(meta.ogSiteName) || host;
  }
  return out;
}
