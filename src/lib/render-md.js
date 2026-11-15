// Render a record as Markdown: YAML frontmatter, a heading per question,
// the answer as typed. The .json written beside it is the canonical copy;
// this one is for reading on the morning of the interview.

// JSON string literals are valid YAML double-quoted scalars, so this quotes
// anything a URL or a job title can throw at it.
const yaml = v => (v == null ? 'null' : JSON.stringify(String(v)));

export function formatBytes(n) {
  if (n == null) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function heading(record) {
  const { company, role } = record.context || {};
  if (role && company) return `${role} at ${company}`;
  return role || record.page.title || company || record.page.url;
}

export function renderMarkdown(record) {
  const lines = [
    '---',
    `captured: ${yaml(record.capturedAt)}`,
    `status: ${yaml(record.status)}`,
    `company: ${yaml(record.context?.company)}`,
    `role: ${yaml(record.context?.role)}`,
    `url: ${yaml(record.page.url)}`,
    `title: ${yaml(record.page.title)}`,
    `trigger: ${yaml(record.trigger)}`,
    `id: ${yaml(record.id)}`,
    '---',
    '',
    `# ${heading(record)}`,
    '',
  ];

  const steps = new Set(record.fields.map(f => f.step ?? 1));
  let step = null;
  for (const f of record.fields) {
    if (steps.size > 1 && f.step !== step) {
      step = f.step;
      lines.push(`*Step ${step}*`, '');
    }
    lines.push(`## ${f.label}`, '');
    const text = f.display === '' || f.display == null ? '_(blank)_' : String(f.display);
    lines.push(text, '');
  }

  if (record.files.length) {
    lines.push('## Files', '');
    for (const f of record.files) {
      lines.push(`- **${f.label}**: \`${f.name}\`, ${formatBytes(f.size)}, ${f.type || 'unknown type'}`);
      if (f.sha256) lines.push(`  sha256 \`${f.sha256}\``);
    }
    lines.push('');
  }

  const notes = [];
  const r = record.redacted || {};
  if (r.secret) notes.push(`${r.secret} sensitive field${r.secret === 1 ? '' : 's'} (passwords, card, bank and ID numbers, date of birth) never recorded`);
  if (r.eeo) notes.push(`${r.eeo} EEO self-ID field${r.eeo === 1 ? '' : 's'} skipped (off by default)`);
  lines.push('---', '', `Recorded by Carbon Copy.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`, '');
  return lines.join('\n');
}
