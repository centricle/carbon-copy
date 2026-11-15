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

Nothing, until you say so. Installing Carbon Copy opens a welcome page that
explains what it records, and it records nothing until you click **Start
recording** there.

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
- fields labeled or named as a Social Security or social insurance number,
  a bank account, routing number, IBAN, SWIFT/BIC or sort code, or a tax ID
  (TIN, EIN, ITIN)
- date of birth, by label, name or `autocomplete="bday"`
- the number typed into a passport, driver's license or national ID field. A
  yes/no question such as "Do you have a valid passport?" is kept.
- any answer that is, in its entirety, a card number (13 to 19 digits passing
  the Luhn check), a nine-digit number (the shape of an SSN or a routing
  number) or a valid IBAN, whatever the field is called. Phone and
  postal-code fields are exempt, and so is text that only mentions a number.
- `type="hidden"` inputs, captcha response tokens, and any field hidden with
  CSS that holds a value the page wrote rather than you

These rules read each field's type, `autocomplete` attribute, label and name,
and the shape of its whole value. They are a safety net, not a guarantee: a
secret written in words, or a number in a shape they do not know, is recorded
like any other answer. The same rules,
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

Recorded without asking, on the candidate side of these applicant tracking
systems:

- Greenhouse job boards (`job-boards.greenhouse.io`, the older
  `boards.greenhouse.io`, and their EU versions)
- Lever (`jobs.lever.co`, `jobs.eu.lever.co`)
- Ashby (`jobs.ashbyhq.com`)
- Workday (`*.myworkdayjobs.com`)
- Workable (`apply.workable.com`)
- SmartRecruiters (`jobs.smartrecruiters.com`)
- iCIMS, the `/jobs/` pages only
- BambooHR, the `/careers/` pages only

Not the recruiter side (`app.greenhouse.io`), and not the employee portals
that iCIMS and BambooHR also run (payroll, onboarding, time off).

Freelance marketplaces (Upwork, Toptal, Wellfound, Contra, Braintrust) are not
in that list, because their proposal forms share pages with chat. They work
through **Record this site**, and there a chat message sent with a Send button
can make a record too.

Anywhere else: open the popup on that site and choose **Record this site**.
Chrome asks for permission for that one site, and only that site. **Stop
recording this site** takes effect at once, in tabs already open on that site
too. Setting Chrome's site access for Carbon Copy to "On all sites" does not
make it record everywhere: it records only on sites added one at a time.

## Install

Not on the Chrome Web Store yet.

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. **Load unpacked** and choose the repo folder.
4. Read the welcome page that opens and click **Start recording**.

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
  that says Submit, Apply or Send. On a site you added yourself, that includes
  a Send button in a chat. It counts only once you have typed, picked or attached
  something: a form holding nothing but the page's own defaults makes no
  record. A submission blocked by the browser's own form validation stays a
  draft. So does a second submission from the same tab and site within a few
  seconds, or the same answers sent again within ten minutes: one copy on
  disk, however often a page submits. **Save files** in the popup writes one
  anyway. A click or a drop that a page script fakes never counts.

## Development

Vanilla JavaScript, Manifest V3, no build step. Node 22 for the tests.

```bash
npm install
npm test                 # unit tests, then the end-to-end suite
npm run test:e2e -- --headed --only=multistep
npm run fixtures         # serve the test forms on http://localhost:7072
npm run build:test       # tmp/test-extension: a copy that also records on localhost
npm run package          # carbon-copy.zip, exactly the files that ship
npm run store-assets     # tmp/store: Web Store screenshots, from the test build
```

The end-to-end suite loads the extension into Playwright's Chromium, fills in
each form in `fixtures/` and checks the stored records and the files on disk.
It never submits anything to a real site. The shipped manifest does not match
localhost; only the test copy does. The test copy is built from the same file
list as the store zip (`scripts/package.mjs`), and the zip is reproducible: the
same commit gives the same bytes.

CI runs the whole suite on every push to `main`. A version tag (`v0.1.0`) runs
it again on the tagged tree, then builds the zip, attests where it was built
and attaches it to a GitHub Release. That release zip is the one uploaded to
the Chrome Web Store, by hand: the repo holds no store credentials. To check a
release zip yourself:

```bash
gh release download v0.1.0 -p carbon-copy.zip
gh attestation verify carbon-copy.zip -R centricle/carbon-copy
```

| Path | What |
|------|------|
| `src/content/capture.js` | Finds fields, resolves labels, snapshots on submit |
| `src/lib/redact.js` | The never-record rules |
| `src/background/sw.js` | Sessions, submit confirmation, storage, disk |
| `src/lib/record.js` | The record schema |
| `src/lib/coverage.js` | Which frames may be recorded (presets, granted sites) |
| `src/lib/throttle.js` | One submission on disk per tab and site at a time |
| `src/lib/render-md.js` | Record to Markdown |
| `src/lib/sink-downloads.js` | Writes the files via `chrome.downloads` |
| `src/presets/jobs.js` | Job-site hosts, and company/role from their URLs |
| `welcome/` | First-run page: what is recorded, and Start recording |
| `scripts/package.mjs` | The list of shipped files, and the store zip |

## License

MIT. See [LICENSE](LICENSE).
