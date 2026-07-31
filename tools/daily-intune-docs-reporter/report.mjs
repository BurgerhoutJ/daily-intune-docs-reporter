#!/usr/bin/env node
/**
 * Daily Intune Docs Reporter
 * -------------------------------------------------------------------------
 * Generates a strict 24-hour (configurable) report of new items from
 * Microsoft's own "What's new" pages for Intune, Windows Autopilot, and
 * Windows 365, then publishes it all as a daily GitHub issue.
 *
 * None of these products' docs sources are usable for PR-based tracking
 * (memdocs' Intune/Autopilot folders don't map cleanly to per-feature
 * announcements, and Windows 365's source repo is private), so instead this
 * scrapes the public "What's new" pages Microsoft already curates. Each
 * product page has a different structure, handled by one of three parsers:
 *
 *   - 'weekly'        Windows 365: <h2>Week of ...</h2> / <h3>item</h3>
 *   - 'weekly-nested'  Intune: <h2>Week of ...</h2> / <h3>category</h3> /
 *                       <h4>item</h4>
 *   - 'dated'          Windows Autopilot: <h2>item</h2> followed by a
 *                       "Date added: <em>...</em>" (and optionally
 *                       "Date updated: <em>...</em>") paragraph
 *
 * Modeled after BakkerJan/entra-docs-daily-reporter-example, adapted for
 * Intune, Windows Autopilot, and Windows 365 content.
 *
 * Usage:
 *   node report.mjs                # generate report files only
 *   node report.mjs --publish      # generate + create/update the daily issue
 *
 * Required env vars (only for --publish):
 *   GITHUB_TOKEN        - token with issues:write on the *target* repo
 *                          (the one this workflow runs in)
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

// "What's new" pages tracked for the report. `parser` selects which of the
// three heading structures (see file header) to use for that page.
const WHATS_NEW_SOURCES = [
  { url: 'https://learn.microsoft.com/en-us/intune/whats-new/', label: 'Intune', parser: 'weekly-nested' },
  { url: 'https://learn.microsoft.com/en-us/autopilot/whats-new', label: 'Windows Autopilot', parser: 'dated' },
  { url: 'https://learn.microsoft.com/en-us/windows-365/enterprise/whats-new', label: 'Windows 365 — Enterprise', parser: 'weekly' },
  { url: 'https://learn.microsoft.com/en-us/windows-365/business/whats-new', label: 'Windows 365 — Business', parser: 'weekly' },
  { url: 'https://learn.microsoft.com/en-us/windows-365/link/whats-new', label: 'Windows 365 — Link', parser: 'weekly' },
  { url: 'https://learn.microsoft.com/en-us/windows-365/agents/whats-new', label: 'Windows 365 — Agents', parser: 'weekly' },
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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse a "<Month> <Day>, <Year>" string into a YYYY-MM-DD string. */
function parseMonthDayYear(str) {
  const m = str.match(/([A-Za-z]+) (\d{1,2}),? (\d{4})/);
  if (!m) return null;
  const monthIndex = MONTH_NAMES.findIndex((name) => name.toLowerCase() === m[1].toLowerCase());
  if (monthIndex === -1) return null;
  const month = String(monthIndex + 1).padStart(2, '0');
  const day = String(m[2]).padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#8217;/g, '’')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ');
}

/** Strip HTML comments/tags from a heading's inner HTML and decode entities. */
function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')).trim();
}

/** Format a YYYY-MM-DD string as "27 Jul 2026" in the given IANA timezone. */
function fmtDateOnly(ymd, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(midnightInTzAsUtc(ymd, tz));
}

// ---------------------------------------------------------------------------
// Page parsers - each returns unfiltered {category, title, url, dateYmd,
// dateLabel} items; date filtering against the report window happens once,
// centrally, in collectWhatsNewItems.
// ---------------------------------------------------------------------------

/** Windows 365 style: <h2>Week of ...</h2> directly followed by <h3> items. */
function parseWeeklyPage(html, source) {
  const items = [];
  const headingRe = /<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>|<h3 id="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/g;
  let currentWeekYmd = null;
  let match;
  while ((match = headingRe.exec(html))) {
    if (match[1] !== undefined) {
      // Only update on a successful parse - stray non-"Week of" h2s (nav,
      // footer headings) shouldn't blow away the current week context.
      const parsed = parseMonthDayYear(stripTags(match[2]).replace(/^Week of /i, ''));
      if (parsed) currentWeekYmd = parsed;
      continue;
    }
    if (!currentWeekYmd) continue;
    const title = stripTags(match[4]);
    if (!title) continue;
    items.push({
      category: source.label,
      title,
      url: `${source.url}#${match[3]}`,
      dateYmd: currentWeekYmd,
      dateLabel: `Week of ${fmtDateOnly(currentWeekYmd, TZ)}`,
    });
  }
  return items;
}

/** Intune style: <h2>Week of ...</h2> / <h3>category</h3> / <h4>item</h4>. */
function parseWeeklyNestedPage(html, source) {
  const items = [];
  const headingRe =
    /<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>|<h3 id="([^"]+)"[^>]*>([\s\S]*?)<\/h3>|<h4 id="([^"]+)"[^>]*>([\s\S]*?)<\/h4>/g;
  let currentWeekYmd = null;
  let currentCategory = null;
  let match;
  while ((match = headingRe.exec(html))) {
    if (match[1] !== undefined) {
      const parsed = parseMonthDayYear(stripTags(match[2]).replace(/^Week of /i, ''));
      if (parsed) currentWeekYmd = parsed;
      continue;
    }
    if (match[3] !== undefined) {
      currentCategory = stripTags(match[4]);
      continue;
    }
    if (!currentWeekYmd) continue;
    const title = stripTags(match[6]);
    if (!title) continue;
    items.push({
      category: `${source.label} — ${currentCategory || 'General'}`,
      title,
      url: `${source.url}#${match[5]}`,
      dateYmd: currentWeekYmd,
      dateLabel: `Week of ${fmtDateOnly(currentWeekYmd, TZ)}`,
    });
  }
  return items;
}

/** Windows Autopilot style: <h2>item</h2> followed by a "Date added: <em>
 * ...</em>" / "Date updated: <em>...</em>" paragraph, no weekly grouping. */
function parseDatedPage(html, source) {
  const items = [];
  const blockRe = /<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2 |$)/g;
  let match;
  while ((match = blockRe.exec(html))) {
    const [, anchor, titleHtml, body] = match;
    const title = stripTags(titleHtml);
    if (!title) continue;

    const addedMatch = body.match(/Date added:\s*<em>([^<]+)<\/em>/i);
    const updatedMatch = body.match(/Date updated:\s*<em>([^<]+)<\/em>/i);
    const addedYmd = addedMatch ? parseMonthDayYear(addedMatch[1]) : null;
    const updatedYmd = updatedMatch ? parseMonthDayYear(updatedMatch[1]) : null;
    if (!addedYmd && !updatedYmd) continue; // nav/footer headings, no date info

    items.push({
      category: source.label,
      title,
      url: `${source.url}#${anchor}`,
      addedYmd,
      updatedYmd,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

const PARSERS = {
  weekly: parseWeeklyPage,
  'weekly-nested': parseWeeklyNestedPage,
  dated: parseDatedPage,
};

/** Scrape every configured "What's new" page and return items that fall
 * inside the strict report window. */
async function collectWhatsNewItems(window) {
  const items = [];

  for (const source of WHATS_NEW_SOURCES) {
    let html;
    try {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      console.error(`Failed to fetch ${source.url}: ${err.message}`);
      continue;
    }

    const parse = PARSERS[source.parser];
    const parsed = parse(html, source);

    for (const item of parsed) {
      if (source.parser === 'dated') {
        // Prefer "updated" as the effective date when it's the one that
        // falls in-window, so a later revision doesn't get relabeled as new.
        const updatedInWindow =
          item.updatedYmd &&
          midnightInTzAsUtc(item.updatedYmd, TZ) >= window.start &&
          midnightInTzAsUtc(item.updatedYmd, TZ) < window.end;
        const addedInWindow =
          item.addedYmd &&
          midnightInTzAsUtc(item.addedYmd, TZ) >= window.start &&
          midnightInTzAsUtc(item.addedYmd, TZ) < window.end;
        if (updatedInWindow) {
          items.push({ ...item, dateLabel: `Updated ${fmtDateOnly(item.updatedYmd, TZ)}` });
        } else if (addedInWindow) {
          items.push({ ...item, dateLabel: `Added ${fmtDateOnly(item.addedYmd, TZ)}` });
        }
        continue;
      }

      const weekStart = midnightInTzAsUtc(item.dateYmd, TZ);
      if (weekStart >= window.start && weekStart < window.end) {
        items.push(item);
      }
    }
  }

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

function renderMarkdown(items, window, reportDateYmd) {
  const lines = [];
  lines.push(`# Daily Intune Docs PR Report - ${reportDateYmd}`);
  lines.push('');
  lines.push(
    `Window: ${fmtLocal(window.start, TZ)} → ${fmtLocal(window.end, TZ)} (${TZ}, ${LOOKBACK_HOURS}h)`
  );
  lines.push('');

  if (items.length === 0) {
    lines.push('No new items were published in this window.');
    return lines.join('\n');
  }

  let currentCategory = null;
  for (const item of items) {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      lines.push(`## ${currentCategory}`);
      lines.push('');
    }
    lines.push(`- [${item.title}](${item.url})`);
    lines.push(`  ${item.dateLabel}`);
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
        <td><a href="${esc(item.url)}">${esc(item.title)}</a></td>
        <td>${esc(item.dateLabel)}</td>
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
      <tr><th>Category</th><th>Title</th><th>Date</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="3">No new items were published in this window.</td></tr>'}
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
      sources: WHATS_NEW_SOURCES,
      itemCount: items.length,
      items: items.map((i) => ({
        category: i.category,
        title: i.title,
        url: i.url,
        dateLabel: i.dateLabel,
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
    `Collecting What's New items: ${window.start.toISOString()} → ${window.end.toISOString()} (${TZ})`
  );

  const items = await collectWhatsNewItems(window);
  console.log(`Found ${items.length} item(s).`);

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
