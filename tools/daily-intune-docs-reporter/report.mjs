#!/usr/bin/env node
/**
 * Daily Intune & Entra Docs Reporter
 * -------------------------------------------------------------------------
 * Generates a strict 24-hour (configurable) report of changes to Microsoft's
 * "What's new" markdown files for Intune, Windows Autopilot, and Windows 365
 * by checking the git diff on the source repositories via the GitHub API,
 * then publishes a digest as a daily GitHub issue.
 *
 * For each tracked source file, the script:
 *   1. Queries the GitHub commits API for commits within the report window
 *   2. Fetches the patch (diff) for each commit
 *   3. Extracts added markdown headings and their descriptions
 *
 * Usage:
 *   node report.mjs                # generate report files only
 *   node report.mjs --publish      # generate + create/update the daily issue
 *
 * Required env vars:
 *   GITHUB_TOKEN        - token with repo read access on the source repos
 *                          AND issues:write on the target repo (for --publish)
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
const TARGET_REPO = process.env.GITHUB_REPOSITORY || '';
const PUBLISH = process.argv.includes('--publish');

// Source markdown files tracked for the report. Each entry specifies the
// GitHub repo, file path, branch, and a public URL base for linking.
const WHATS_NEW_SOURCES = [
  {
    repo: 'MicrosoftDocs/memdocs',
    path: 'intune/whats-new/index.md',
    branch: 'main',
    label: 'Intune',
    docsUrl: 'https://learn.microsoft.com/en-us/mem/intune/fundamentals/whats-new',
  },
  {
    repo: 'MicrosoftDocs/memdocs',
    path: 'autopilot/whats-new.md',
    branch: 'main',
    label: 'Windows Autopilot',
    docsUrl: 'https://learn.microsoft.com/en-us/autopilot/whats-new',
  },
  {
    repo: 'MicrosoftDocs/entra-docs',
    path: 'docs/fundamentals/whats-new.md',
    branch: 'main',
    label: 'Microsoft Entra',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/fundamentals/whats-new',
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

function midnightInTzAsUtc(ymd, tz) {
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

function computeWindow(now, tz, lookbackHours) {
  const todayYmd = ymdInTz(now, tz);
  const todayMidnightUtc = midnightInTzAsUtc(todayYmd, tz);
  const end = todayMidnightUtc;
  const start = new Date(end.getTime() - lookbackHours * 60 * 60 * 1000);
  return { start, end, reportDateYmd: ymdInTz(start, tz) };
}

// ---------------------------------------------------------------------------
// Diff-based data collection
// ---------------------------------------------------------------------------

async function getCommitsForFile(repo, filePath, branch, since, until) {
  const params = new URLSearchParams({
    sha: branch,
    path: filePath,
    since: since.toISOString(),
    until: until.toISOString(),
    per_page: '100',
  });
  const url = `${GITHUB_API}/repos/${repo}/commits?${params}`;
  return await ghFetch(url);
}

async function getCommitPatch(repo, sha, filePath) {
  const url = `${GITHUB_API}/repos/${repo}/commits/${sha}`;
  try {
    const commit = await ghFetch(url);
    const file = (commit.files || []).find((f) => f.filename === filePath);
    return file?.patch || '';
  } catch (err) {
    console.error(`Failed to get patch for ${repo}@${sha}: ${err.message}`);
    return '';
  }
}

/** Extract added markdown headings and their first paragraph from a unified diff patch. */
function parseAddedSectionsFromPatch(patch) {
  const items = [];
  const lines = patch.split('\n');
  let currentHeading = null;
  let currentBody = [];

  for (const line of lines) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);

    const headingMatch = content.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) {
        items.push({ level: currentHeading.level, title: currentHeading.title, body: currentBody.join(' ').trim() });
      }
      currentHeading = { level: headingMatch[1].length, title: headingMatch[2].trim() };
      currentBody = [];
      continue;
    }

    if (currentHeading && content.trim()) {
      currentBody.push(content.trim());
    }
  }
  if (currentHeading) {
    items.push({ level: currentHeading.level, title: currentHeading.title, body: currentBody.join(' ').trim() });
  }
  return items;
}

async function collectWhatsNewItems(window) {
  if (!GITHUB_TOKEN) {
    console.warn('Warning: No GITHUB_TOKEN set. Unauthenticated requests are rate-limited to 60/hr and cannot access private repos.');
  }

  const items = [];

  for (const source of WHATS_NEW_SOURCES) {
    console.log(`  Checking ${source.label}: ${source.repo}/${source.path}`);
    let commits;
    try {
      commits = await getCommitsForFile(source.repo, source.path, source.branch, window.start, window.end);
    } catch (err) {
      console.warn(`    Skipping ${source.label}: ${err.message}`);
      continue;
    }

    if (commits.length === 0) {
      console.log(`    No commits found in window.`);
      continue;
    }
    console.log(`    Found ${commits.length} commit(s).`);

    const seen = new Set();

    for (const commit of commits) {
      const patch = await getCommitPatch(source.repo, commit.sha, source.path);
      if (!patch) continue;

      const sections = parseAddedSectionsFromPatch(patch);
      const commitDate = commit.commit.committer.date || commit.commit.author.date;

      for (const section of sections) {
        // Skip structural headings
        if (/^week of /i.test(section.title)) continue;
        if (/^notices$/i.test(section.title)) continue;
        // Skip category-level headings (e.g. "Device configuration", "App management")
        if (section.level <= 3 && !section.body) continue;

        const key = `${source.label}::${section.title}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const anchor = section.title
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-');

        items.push({
          category: source.label,
          title: section.title,
          url: `${source.docsUrl}#${anchor}`,
          commitUrl: commit.html_url,
          commitDate,
          dateLabel: new Date(commitDate).toLocaleDateString('en-GB', {
            timeZone: TZ,
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }),
        });
      }
    }
  }

  items.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  return items;
}

// ---------------------------------------------------------------------------
// Microsoft 365 Roadmap
// ---------------------------------------------------------------------------

const ROADMAP_RSS_URL = 'https://www.microsoft.com/en-us/microsoft-365/RoadmapFeatureRSS/';
const ROADMAP_PRODUCT_FILTERS = ['Microsoft Intune', 'Microsoft Entra', 'Windows Autopilot', 'Windows 365'];

async function collectRoadmapItems(window) {
  let xml;
  try {
    const res = await fetch(ROADMAP_RSS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    console.warn(`  Skipping M365 Roadmap: ${err.message}`);
    return [];
  }

  const items = [];
  const rssItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  for (const [, body] of rssItems) {
    const categories = [...body.matchAll(/<category>([^<]+)<\/category>/g)].map((m) => m[1]);
    const matchedProduct = categories.find((c) => ROADMAP_PRODUCT_FILTERS.includes(c));
    if (!matchedProduct) continue;

    const pubDateStr = body.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    if (!pubDateStr) continue;
    const pubDate = new Date(pubDateStr);
    if (pubDate < window.start || pubDate >= window.end) continue;

    const title = body.match(/<title>([^<]+)<\/title>/)?.[1];
    const link = body.match(/<link>([^<]+)<\/link>/)?.[1];
    const status = categories.find((c) => ['In development', 'Rolling out', 'Launched'].includes(c)) || '';
    if (!title) continue;

    items.push({
      category: `${matchedProduct} — Roadmap`,
      title,
      url: link || '',
      commitUrl: '',
      commitDate: pubDate.toISOString(),
      dateLabel: `${status} · ${pubDate.toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })}`,
    });
  }

  console.log(`  Checking M365 Roadmap: found ${items.length} item(s) in window.`);
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
  lines.push(`# Daily Intune & Entra Report - ${reportDateYmd}`);
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
        <td>${item.commitUrl ? `<a href="${esc(item.commitUrl)}">diff</a>` : ''}</td>
        <td>${esc(item.dateLabel)}</td>
      </tr>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Daily Intune & Entra Report - ${esc(reportDateYmd)}</title>
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
  <h1>Daily Intune & Entra Report - ${esc(reportDateYmd)}</h1>
  <p class="meta">Window: ${esc(fmtLocal(window.start, TZ))} → ${esc(fmtLocal(window.end, TZ))} (${esc(TZ)}, ${LOOKBACK_HOURS}h)</p>
  <table>
    <thead>
      <tr><th>Category</th><th>Title</th><th>Commit</th><th>Date</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="4">No new items were published in this window.</td></tr>'}
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
      sources: WHATS_NEW_SOURCES.map((s) => ({ repo: s.repo, path: s.path, label: s.label })),
      itemCount: items.length,
      items: items.map((i) => ({
        category: i.category,
        title: i.title,
        url: i.url,
        commitUrl: i.commitUrl,
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
    `Collecting What's New items from markdown diffs: ${window.start.toISOString()} → ${window.end.toISOString()} (${TZ})`
  );

  const docsItems = await collectWhatsNewItems(window);
  console.log(`Found ${docsItems.length} docs item(s).`);

  const roadmapItems = await collectRoadmapItems(window);

  const items = [...docsItems, ...roadmapItems];
  items.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  console.log(`Total: ${items.length} item(s).`);

  const md = renderMarkdown(items, window, window.reportDateYmd);
  const html = renderHtml(items, window, window.reportDateYmd);
  const json = renderJson(items, window, window.reportDateYmd);

  // Separate markdown outputs for the Jekyll site
  const docsMd = renderMarkdown(docsItems, window, window.reportDateYmd);
  const roadmapMd = renderMarkdown(roadmapItems, window, window.reportDateYmd);

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, 'report.md'), md, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, 'report.html'), html, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, 'report.json'), json, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, 'report-docs.md'), docsMd, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, 'report-roadmap.md'), roadmapMd, 'utf8');
  console.log(`Wrote artifacts to ${OUTPUT_DIR}/`);

  if (PUBLISH) {
    if (!GITHUB_TOKEN || !TARGET_REPO) {
      throw new Error('--publish requires GITHUB_TOKEN and GITHUB_REPOSITORY to be set.');
    }
    const title = `Daily Intune & Entra Report - ${window.reportDateYmd}`;
    const result = await publishIssue(TARGET_REPO, title, md);
    console.log(`Issue ${result.action}: #${result.number} in ${TARGET_REPO}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
