# Privacy Policy

**Carbon Copy** keeps a copy of what you type into web forms so you can read it
later. Everything it keeps stays on your computer.

## What it stores

Nothing until you agree to it. Installing Carbon Copy opens a welcome page
that describes what it records, and it records nothing until you click
**Start recording** there.

Once you have, on sites it is allowed to run on, Carbon Copy reads the form fields on the
page: each field's label and the value you entered, plus the name, size, type
and a SHA-256 hash of any file you attach. It reads an attached file only
inside the page, to compute that hash, and never stores or sends its contents.
Each record also keeps the page's full address and title.

While you fill in a form, Carbon Copy keeps a draft of it in the browser, so
an unsent application is stored too.

It skips password fields, fields marked as one-time codes, and fields marked
or labeled as payment card details, bank details, a tax ID, a Social Security
or social insurance number, or a date of birth, plus the number typed into a
passport, driver's license or national ID field. It recognizes these by each
field's type, `autocomplete` attribute, label and name. It also skips any
answer that is, in its entirety, a card number, a nine-digit number such as an
SSN or routing number, or an IBAN, whatever the field is called; phone and
postal-code fields are exempt. These rules are a safety net: a sensitive
answer in a shape they do not recognize, such as one written out in words, is
stored like any other. EEO self-identification answers
are not stored unless you turn that on in the popup. Both rules apply to
attached files too, judged by the label of the field or drop zone the file
went into: a skipped file's name and hash are not stored.

## Where it is stored

- In your browser's local extension storage (IndexedDB), on your device.
  Records, drafts included, stay there until you remove the extension.
  **Clear** in the popup removes the submissions already saved to disk.
- Your settings (including when you clicked Start recording), in the
  extension's local storage, and a note of which open
  tab belongs to which record, in its session storage, which the browser
  empties when it closes.
- In files that Carbon Copy saves to your Downloads folder when you submit a
  form, or when you choose to save or export from the popup. Saving or
  exporting from the popup can include drafts.

## What leaves your device

Nothing. Carbon Copy makes no network requests. There is no account, no
server, no analytics, no tracking and no third-party code.

## Permissions

| Permission | Why |
|------------|-----|
| Access to the candidate pages of job application sites: Greenhouse and Lever job boards, Ashby, Workday, Workable, SmartRecruiters, and the `/jobs/` pages of iCIMS and `/careers/` pages of BambooHR | Read the application forms you fill in there |
| Access to other sites, only if you grant it | "Record this site" asks for one site at a time. A blanket grant ("On all sites") is ignored |
| `downloads` | Save each submission as files in your Downloads folder |
| `storage` | Keep records and settings in the browser |
| `scripting` | Start recording on a site you just added, without a reload |
| `activeTab` | Show the current site's status in the popup |

## Deleting your data

Delete the files from your Downloads folder. Removing the extension deletes
everything it stored in the browser. Carbon Copy removes each save from
Chrome's download list (`chrome://downloads`) as soon as it finishes, whether
it worked or not, so no copy is left there.

## Contact

Open an issue on [GitHub](https://github.com/centricle/carbon-copy).
