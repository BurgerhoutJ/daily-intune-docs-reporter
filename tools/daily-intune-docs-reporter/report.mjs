#!/usr/bin/env node
/**
 * Daily Intune Docs Reporter
 * -------------------------------------------------------------------------
 * Generates a strict 24-hour (configurable) report of documentation changes
 * merged into Microsoft's public Intune / endpoint management docs repo
 * (MicrosoftDocs/memdocs), then publishes it as a daily GitHub issue.
 *
 * Modeled after BakkerJan/entra-docs-daily-reporter-example, adapted for
 * Intune, Windows Autopilot, and Endpoint Security content.
 *
 * Usage:
 *   node report.mjs                # generate report files only
 *   node report.mjs --publish      # generate + create/update the daily issue
 *
 * Required env vars:
 *   GITHUB_TOKEN        - token with public repo read + (for --publish) issues:write
 *                          on the *target* repo (the one this workflow runs in)
 *
 * Optional env vars:
 *   LOOKBACK_HOURS       - size of the report window in hours (default: 24)
 *   TZ_REPORT            - IANA timezone for window boundaries & timestamps
 *                          (default: Europe/Amsterdam)
 *   OUTPUT_DIR           - where html/md/json artifacts are written (default: ./out)
 *   GITHUB_REPOSITORY    - "owner/repo" of the repo to publish the issue into
 *                          (auto-set by GitHub Actions)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const TZ = process.env.TZ_REPORT || 'Europe/Amsterdam';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './out';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TARGET_REPO = process.env.GITHUB_REPOSITORY || ''; // owner/repo to publish into
const PUBLISH = process.argv.includes('--publish');

// Sources tracked for the report. Each entry is a docs "root" folder inside
// a GitHub repo. Categories are derived automatically from the first folder
// segment under `pathPrefix` - no fixed category list to maintain.
const PUBLISH_SOURCES = [
  {
    repo: 'MicrosoftDocs/memdocs',
    pathPrefix: 'intune/',
    learnBase: 'https://learn.microsoft.com/en-us/mem/intune/',
    label: 'Intune',
  },
  {
    repo: 'MicrosoftDocs/memdocs',
    pathPrefix: 'autopilot/',
    learnBase: 'https://learn.microsoft.com/en-us/autopilot/',
    label: 'Windows Autopilot',
  },
];

const GITHUB_API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ghHeaders(extra = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

async function ghFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: ghHeaders(options.headers) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function ghFetchAllPages(url) {
  let results = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers: ghHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} for ${next}: ${body.slice(0, 500)}`);
    }
    const page = await res.json();
    const items = Array.isArray(page) ? page : page.items || [];
    results = results.concat(items);
    const link = res.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    next = match ? match[1] : null;
  }
  return results;
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
function ymdInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Midnight (00:00:00) in `tz` for the given YYYY-MM-DD, returned as a UTC Date. */
function midnightInTzAsUtc(ymd, tz) {
  // Binary-search style: start from a naive UTC guess, then correct using the
  // timezone offset reported for that instant so DST transitions are handled.
  const naive = new Date(`${ymd}T00:00:00Z`);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    hour12: false,
  });
  const offsetPart = dtf.formatToParts(naive).find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
  const offsetMatch = offsetPart.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  const offsetHours = offsetMatch ? Number(offsetMatch[1]) : 0;
  const offsetMinutes = offsetMatch && offsetMatch[2] ? Number(offsetMatch[2]) : 0;
  const offsetMs = (offsetHours * 60 + Math.sign(offsetHours || 1) * offsetMinutes) * 60 * 1000;
  return new Date(naive.getTime() - offsetMs);
}

/** Build the strict, non-overlapping report window: the most recently
 * completed midnight-to-midnight calendar day in `tz`, clipped/extended to
 * LOOKBACK_HOURS. Re-running the same day always yields the same window. */
function computeWindow(now, tz, lookbackHours) {
  const todayYmd = ymdInTz(now, tz);
  const todayMidnightUtc = midnightInTzAsUtc(todayYmd, tz);
  const end = todayMidnightUtc; // today 00:00 local
  const start = new Date(end.getTime() - lookbackHours * 60 * 60 * 1000);
  return { start, end, reportDateYmd: ymdInTz(start, tz) };
}

function humanizeSegment(segment) {
  return segment
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toLowerCase() ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function deriveCategory(relativePath, source) {
  const firstSegment = relativePath.split('/')[0];
  if (!firstSegment || firstSegment.endsWith('.md') || firstSegment.endsWith('.yml')) {
    return source.label;
  }
  return `${source.label} — ${humanizeSegment(firstSegment)}`;
}

function relativeToRepo(filePath, prefix) {
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

function learnUrlFor(relativePath, source) {
  let withoutExt = relativePath.replace(/\.(md|yml)$/i, '');
  if (withoutExt.endsWith('/index')) withoutExt = withoutExt.slice(0, -('/index'.length));
  if (withoutExt === 'index') withoutExt = '';
  return source.learnBase + withoutExt;
}

async function tryExtractTitle(repo, filePath, ref) {
  try {
    const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURI(filePath)}?ref=${ref}`;
    const data = await ghFetch(url, { headers: { Accept: 'application/vnd.github.raw+json' } });
    // When Accept is the raw media type, GitHub returns the file's text content
    // directly rather than the JSON content object.
    const text = typeof data === 'string' ? data : Buffer.from(data.content || '', 'base64').toString('utf8');
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;
    const titleMatch = fmMatch[1].match(/^\s*title:\s*(.+?)\s*$/m);
    if (!titleMatch) return null;
    return titleMatch[1].replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}

function filenameToTitle(relativePath) {
  const base = path.basename(relativePath, path.extname(relativePath));
  if (base === 'index') {
    const parent = relativePath.split('/').slice(-2, -1)[0] || '';
    return humanizeSegment(parent) + ' (overview)';
  }
  return humanizeSegment(base);
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function findMergedPRs(repo, start, end) {
  const startIso = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const endIso = end.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:${startIso}..${endIso}`);
  const url = `${GITHUB_API}/search/issues?q=${q}&per_page=100`;
  return ghFetchAllPages(url);
}

async function getPRFiles(repo, prNumber) {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
  return ghFetchAllPages(url);
}

async function collectItems(window) {
  const items = [];
  const bySource = new Map();

  // Group sources by underlying repo so we only query merged PRs once per repo.
  const reposSeen = new Set();
  for (const source of PUBLISH_SOURCES) {
    if (reposSeen.has(source.repo)) continue;
    reposSeen.add(source.repo);

    const prs = await findMergedPRs(source.repo, window.start, window.end);
    for (const pr of prs) {
      const files = await getPRFiles(source.repo, pr.number);
      for (const file of files) {
        if (file.status === 'removed') continue; // nothing to link to
        const matchingSource = PUBLISH_SOURCES.find(
          (s) => s.repo === source.repo && file.filename.startsWith(s.pathPrefix)
        );
        if (!matchingSource) continue;
        if (!file.filename.endsWith('.md') && !file.filename.endsWith('.yml')) continue;

        const relativePath = relativeToRepo(file.filename, matchingSource.pathPrefix);
        const key = `${source.repo}::${file.filename}::${pr.number}`;
        if (bySource.has(key)) continue;
        bySource.set(key, true);

        items.push({
          repo: source.repo,
          source: matchingSource,
          filePath: file.filename,
          relativePath,
          status: file.status, // added | modified | renamed
          prNumber: pr.number,
          prTitle: pr.title,
          prAuthor: pr.user?.login || 'unknown',
          mergedAt: pr.closed_at || pr.updated_at,
          sourceUrl: `https://github.com/${source.repo}/blob/main/${file.filename}`,
        });
      }
    }
  }

  // Enrich with real doc titles where possible (best-effort, capped to avoid
  // hammering the API when a huge number of files changed in one day).
  const TITLE_FETCH_CAP = 60;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let title = null;
    if (i < TITLE_FETCH_CAP) {
      title = await tryExtractTitle(item.repo, item.filePath, 'main');
    }
    item.title = title || filenameToTitle(item.relativePath);
    item.category = deriveCategory(item.relativePath, item.source);
    item.learnUrl = learnUrlFor(item.relativePath, item.source);
  }

  // Sort by category, then title, for a stable digest.
  items.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  return items;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtLocal(iso, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function statusLabel(status) {
  if (status === 'added') return 'new';
  if (status === 'renamed') return 'renamed';
  return 'updated';
}

function renderMarkdown(items, window, reportDateYmd) {
  const lines = [];
  lines.push(`# Daily Intune Docs PR Report - ${reportDateYmd}`);
  lines.push('');
  lines.push(
    `Window: ${fmtLocal(window.start, TZ)} → ${fmtLocal(window.end, TZ)} (${TZ}, ${LOOKBACK_HOURS}h)`
  );
  lines.push('');

  if (items.length === 0) {
    lines.push('No documentation changes were merged in this window.');
    return lines.join('\n');
  }

  let currentCategory = null;
  for (const item of items) {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      lines.push(`## ${currentCategory}`);
      lines.push('');
    }
    const linkUrl = item.status === 'added' ? item.sourceUrl : item.learnUrl;
    const linkLabel = item.status === 'added' ? `${item.title} (not yet on Learn)` : item.title;
    lines.push(`- [${linkLabel}](${linkUrl})`);
    lines.push(
      `  ${fmtLocal(item.mergedAt, TZ)} · ${statusLabel(item.status)} via [PR #${item.prNumber}](https://github.com/${item.repo}/pull/${item.prNumber}) by @${item.prAuthor}` +
        (item.status !== 'added' ? ` · [source](${item.sourceUrl})` : '')
    );
    lines.push('');
  }

  return lines.join('\n');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(items, window, reportDateYmd) {
  const rows = items
    .map(
      (item) => `<tr>
        <td>${esc(item.category)}</td>
        <td><a href="${esc(item.learnUrl)}">${esc(item.title)}</a></td>
        <td>${esc(statusLabel(item.status))}</td>
        <td><a href="https://github.com/${esc(item.repo)}/pull/${item.prNumber}">#${item.prNumber}</a></td>
        <td>${esc(item.prAuthor)}</td>
        <td>${esc(fmtLocal(item.mergedAt, TZ))}</td>
        <td><a href="${esc(item.sourceUrl)}">source</a></td>
      </tr>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Daily Intune Docs PR Report - ${esc(reportDateYmd)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  tr:nth-child(even) { background: #fafafa; }
  .meta { color: #555; }
</style>
</head>
<body>
  <h1>Daily Intune Docs PR Report - ${esc(reportDateYmd)}</h1>
  <p class="meta">Window: ${esc(fmtLocal(window.start, TZ))} → ${esc(fmtLocal(window.end, TZ))} (${esc(TZ)}, ${LOOKBACK_HOURS}h)</p>
  <table>
    <thead>
      <tr><th>Category</th><th>Title</th><th>Status</th><th>PR</th><th>Author</th><th>Merged</th><th>Source</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7">No documentation changes were merged in this window.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}

function renderJson(items, window, reportDateYmd) {
  return JSON.stringify(
    {
      reportDate: reportDateYmd,
      window: {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        timezone: TZ,
        lookbackHours: LOOKBACK_HOURS,
      },
      sources: PUBLISH_SOURCES,
      itemCount: items.length,
      items: items.map((i) => ({
        repo: i.repo,
        category: i.category,
        title: i.title,
        status: i.status,
        filePath: i.filePath,
        learnUrl: i.learnUrl,
        sourceUrl: i.sourceUrl,
        prNumber: i.prNumber,
        prTitle: i.prTitle,
        prAuthor: i.prAuthor,
        mergedAt: i.mergedAt,
      })),
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function findExistingIssue(repo, title) {
  const q = encodeURIComponent(`repo:${repo} is:issue in:title "${title}"`);
  const url = `${GITHUB_API}/search/issues?q=${q}`;
  const data = await ghFetch(url);
  return (data.items || []).find((i) => i.title === title) || null;
}

async function publishIssue(repo, title, body) {
  const existing = await findExistingIssue(repo, title);
  if (existing) {
    await ghFetch(`${GITHUB_API}/repos/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Refreshed report:\n\n${body}` }),
    });
    return { number: existing.number, action: 'commented' };
  }
  const created = await ghFetch(`${GITHUB_API}/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels: ['intune-docs-report'] }),
  });
  return { number: created.number, action: 'created' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const now = new Date();
  const window = computeWindow(now, TZ, LOOKBACK_HOURS);

  console.log(
    `Collecting Intune docs changes: ${window.start.toISOString()} → ${window.end.toISOString()} (${TZ})`
  );

  const items = await collectItems(window);
  console.log(`Found ${items.length} documentation file change(s).`);

  const md = renderMarkdown(items, window, window.reportDateYmd);
  const html = renderHtml(items, window, window.reportDateYmd);
  const json = renderJson(items, window, window.reportDateYmd);

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, 'report.md'), md, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, 'report.html'), html, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, 'report.json'), json, 'utf8');
  console.log(`Wrote artifacts to ${OUTPUT_DIR}/ (report.md, report.html, report.json)`);

  if (PUBLISH) {
    if (!GITHUB_TOKEN || !TARGET_REPO) {
      throw new Error('--publish requires GITHUB_TOKEN and GITHUB_REPOSITORY to be set.');
    }
    const title = `Daily Intune Docs PR Report - ${window.reportDateYmd}`;
    const result = await publishIssue(TARGET_REPO, title, md);
    console.log(`Issue ${result.action}: #${result.number} in ${TARGET_REPO}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
