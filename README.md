# Carbon Copy

Keeps a copy of what you submit in job applications and other web forms, as
plain files on your own disk.

You wrote three paragraphs on why you want the job, picked a start date, named
a rate. Two weeks later a recruiter calls and you can't remember any of it.
Most applicant tracking systems never show you your answers again. Carbon Copy
keeps them.

- **Local-first.** Records live in your browser and in files you own. Nothing is
  sent anywhere. No account, no server, no analytics.
- **Plain files.** Every submission becomes a Markdown file you can read and a
  JSON file a script can read, in `~/Downloads/carbon-copy/`.
- **The questions, not just the answers.** Each answer is filed under the
  question it answered, read from the page itself, so `question_48213: yes`
  comes out as "Are you willing to relocate? Yes".
- **Works on any form.** Job sites are covered out of the box. Anything else is
  one click: "Record this site".

## What a record looks like

```markdown
---
captured: "2026-11-15T19:26:34.588Z"
status: "submitted"
company: "ACME Corporation"
role: "Senior Anvil Engineer"
url: "https://boards.greenhouse.io/acme/jobs/123"
---

# Senior Anvil Engineer at ACME Corporation

## Earliest start date

2026-12-01

## Why ACME?

Because ACME ships to the desert overnight.

## Files

- **Resume/CV**: `wile-e-coyote-resume.pdf`, 48.2 KB, application/pdf
  sha256 `a24112e3…`
```

The file hash answers "which version of my resume did I send?"

## What is recorded, and what is skipped

Recorded, at the moment you press Submit: every text field, text area,
dropdown, radio group, checkbox and rich-text editor in the form, with its
label, plus the name, size, type and SHA-256 hash of any file you attach. The
file is read inside the page to compute the hash, and its contents are never
stored. The record also keeps the page's full address (query string included)
and title.

Skipped before anything leaves the page:

- password fields, and fields marked as passwords or one-time codes
- fields marked `autocomplete="cc-*"`, or labeled or named as a card number
  or CVV
- fields labeled or named as a Social Security or social insurance number
- `type="hidden"` inputs, captcha response tokens, and any field hidden with
  CSS that holds a value the page wrote rather than you

These rules read each field's type, `autocomplete` attribute, label and name,
never its value. A sensitive answer in a field with an ordinary label, such as
a bank account number, is recorded like any other answer. The same rules,
and the EEO setting below, cover file uploads, judged by the label of the
input or drop zone: a file attached as a Social Security card is not
recorded at all, name and hash included. A field hidden with CSS is kept if
you filled it in, because that is how single-page forms hide the steps you
have already finished.

EEO self-identification answers (gender, race, veteran and disability status)
are skipped by default, recognized by their labels and by the section of the
form they sit in. A toggle in the popup turns them on.

While you type, a draft is kept in the browser so a crash or a closed tab does
not lose your work. Only a submission writes files on its own. A draft reaches
disk only if you choose **Save files** on it in the popup, or **Export all**,
which includes drafts. Drafts stay in the browser until you remove the
extension: **Clear** removes only submissions already saved to disk.

## Sites

Recorded without asking, on every page of these sites and not only their
application forms: Greenhouse, Lever, Ashby, Workday, Workable,
SmartRecruiters, iCIMS, BambooHR, Upwork, Toptal, Wellfound, Contra and
Braintrust.

Anywhere else: open the popup on that site and choose **Record this site**.
Chrome asks for permission for that one site, and only that site. **Stop
recording this site** applies to pages you open afterward, so reload any tab
already open on that site.

## Install

Not on the Chrome Web Store yet.

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** and choose the repo folder.

## Good to know

- **Chrome's "Ask where to save each file" setting** may show a save dialog
  for each file. Turn it off, or expect two dialogs per submission.
- **Don't make `~/Downloads/carbon-copy` a symlink.** Chrome will not write
  through one: it either cancels the save or drops a file named `download.md`
  at the top of your Downloads folder. Carbon Copy flags either case on the
  record ("not saved" or "saved elsewhere") and you can re-save from the popup.
- **Multi-page applications** that load a new page per step (rather than
  swapping steps in place) produce one record per page for now.
- **Submit detection** is a heuristic: a submit event, or a click on a button
  that says Submit, Apply or Send. That includes a Send button in a chat on a
  recorded site. It counts only once you have typed, picked or attached
  something: a form holding nothing but the page's own defaults makes no
  record. A submission blocked by the browser's own form validation stays a
  draft.

## Development

Vanilla JavaScript, Manifest V3, no build step. Node 22 for the tests.

```bash
npm install
npm test                 # unit tests, then the end-to-end suite
npm run test:e2e -- --headed --only=multistep
npm run fixtures         # serve the test forms on http://localhost:7072
npm run build:test       # tmp/test-extension: a copy that also records on localhost
```

The end-to-end suite loads the extension into Playwright's Chromium, fills in
each form in `fixtures/` and checks the stored records and the files on disk.
It never submits anything to a real site. The shipped manifest does not match
localhost; only the test copy does.

| Path | What |
|------|------|
| `src/content/capture.js` | Finds fields, resolves labels, snapshots on submit |
| `src/lib/redact.js` | The never-record rules |
| `src/background/sw.js` | Sessions, submit confirmation, storage, disk |
| `src/lib/record.js` | The record schema |
| `src/lib/render-md.js` | Record to Markdown |
| `src/lib/sink-downloads.js` | Writes the files via `chrome.downloads` |
| `src/presets/jobs.js` | Job-site hosts, and company/role from their URLs |

## License

MIT. See [LICENSE](LICENSE).
