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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const TZ = process.env.TZ_REPORT || 'Europe/Amsterdam';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './out';
const STATE_DIR = process.env.STATE_DIR || './state';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TARGET_REPO = process.env.GITHUB_REPOSITORY || '';
const PUBLISH = process.argv.includes('--publish');

// ---------------------------------------------------------------------------
// Seen-item state (dedup for the live-page fallback sources)
// ---------------------------------------------------------------------------
//
// The primary "what's new" and roadmap collectors above key off a strict
// time window (commit dates / RSS pubDate). The live-page fallbacks below
// have no such window to lean on, since a page fetch only ever shows
// "what's on the page right now". Instead they remember every item key
// they've ever reported in a small JSON file committed alongside the site,
// and only report items that aren't in that file yet. On the very first run
// (no state file), everything currently on the page is seeded into the
// state file unreported, so we don't dump the entire page history into one
// report.

function itemKey(label, title) {
  return `${label}::${title}`;
}

async function loadSeenState(name) {
  const file = path.join(STATE_DIR, name);
  try {
    const raw = await readFile(file, 'utf8');
    const data = JSON.parse(raw);
    return { data, touched: {}, isBootstrap: false };
  } catch {
    return { data: {}, touched: {}, isBootstrap: true };
  }
}

async function saveSeenState(name, state) {
  const file = path.join(STATE_DIR, name);
  const merged = { ...state.data, ...state.touched };
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

// Source markdown files tracked for the report. Each entry specifies the
// GitHub repo, file path, branch, and a public URL base for linking.
//
// `itemHeadingLevel` describes the HTML heading level that marks an
// individual "what's new" entry on the live docs page (used by the live-page
// fallback below) — it varies per page: Intune groups entries under
// Week (h2) > Category (h3) > Item (h4); Microsoft Entra groups them under
// Month (h2) > Item (h3); Windows Autopilot lists entries flat as (h2) with
// no further grouping.
const WHATS_NEW_SOURCES = [
  {
    repo: 'MicrosoftDocs/memdocs',
    path: 'intune/whats-new/index.md',
    branch: 'main',
    label: 'Intune',
    docsUrl: 'https://learn.microsoft.com/en-us/intune/whats-new/',
    itemHeadingLevel: 4,
  },
  {
    repo: 'MicrosoftDocs/memdocs',
    path: 'autopilot/whats-new.md',
    branch: 'main',
    label: 'Windows Autopilot',
    docsUrl: 'https://learn.microsoft.com/en-us/autopilot/whats-new',
    itemHeadingLevel: 2,
  },
  {
    repo: 'MicrosoftDocs/memdocs',
    path: 'autopilot/device-preparation/whats-new.md',
    branch: 'main',
    label: 'Windows Autopilot device preparation',
    docsUrl: 'https://learn.microsoft.com/en-us/autopilot/device-preparation/whats-new',
    itemHeadingLevel: 2,
  },
  {
    repo: 'MicrosoftDocs/entra-docs',
    path: 'docs/fundamentals/whats-new.md',
    branch: 'main',
    label: 'Microsoft Entra',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/fundamentals/whats-new',
    itemHeadingLevel: 3,
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
  let currentParentCategory = '';

  for (const line of lines) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);

    const headingMatch = content.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) {
        items.push({ level: currentHeading.level, title: currentHeading.title, body: currentBody.join(' ').trim(), parentCategory: currentHeading.parentCategory });
      }
      const level = headingMatch[1].length;
      if (level === 3) currentParentCategory = headingMatch[2].trim();
      currentHeading = { level, title: headingMatch[2].trim(), parentCategory: level === 4 ? currentParentCategory : '' };
      currentBody = [];
      continue;
    }

    if (currentHeading && content.trim()) {
      currentBody.push(content.trim());
    }
  }
  if (currentHeading) {
    items.push({ level: currentHeading.level, title: currentHeading.title, body: currentBody.join(' ').trim(), parentCategory: currentHeading.parentCategory });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Live-page fallback (used when the GitHub source mirror hasn't synced yet)
// ---------------------------------------------------------------------------
//
// MicrosoftDocs' public GitHub mirrors occasionally fall behind the live
// learn.microsoft.com pages by days or weeks (the docs are authored and
// published from an internal branch first). When that happens the
// commit-diff collector above legitimately finds nothing, even though the
// live page has moved on. As a fallback, fetch the rendered page directly
// and diff its current items against a persisted "seen" list.

function stripHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const BOILERPLATE_HEADING_IDS = new Set([
  'ms--in-this-article',
  'related-content',
  'ms--feedback',
  'ms--additional-resources-mobile-heading',
]);
const BOILERPLATE_HEADING_TEXT = /^(in this article|related content|feedback|additional resources|next steps|see also)$/i;

/** Parse a "Week of <date>" / "<Month> <Year>" period heading, or a "Date added: <date>" line in the body. */
function parseSectionDate(period, bodyText) {
  if (period) {
    let m = period.match(/Week of ([A-Za-z]+ \d{1,2}, \d{4})/i);
    if (m) return new Date(`${m[1]} UTC`);
    m = period.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (m) return new Date(`${m[1]} 1, ${m[2]} UTC`);
  }
  const m2 = bodyText.match(/Date added:\s*([A-Za-z]+ \d{1,2},?\s*\d{4})/i);
  if (m2) return new Date(`${m2[1].replace(',', '')} UTC`);
  return null;
}

/**
 * Parse "what's new" entries out of a rendered docs page. `itemHeadingLevel`
 * (2, 3, or 4) says which heading level represents one entry — see the
 * comment on WHATS_NEW_SOURCES for why this varies per page.
 */
function parseWhatsNewLivePage(html, itemHeadingLevel) {
  const headingRe = /<h([234])([^>]*)>([\s\S]*?)<\/h\1>/g;
  const idRe = /\bid="([^"]*)"/;
  const headings = [];
  let match;
  while ((match = headingRe.exec(html))) {
    const level = Number(match[1]);
    const idMatch = match[2].match(idRe);
    const id = idMatch ? idMatch[1] : '';
    const text = stripHtml(match[3]);
    if (BOILERPLATE_HEADING_IDS.has(id) || BOILERPLATE_HEADING_TEXT.test(text)) continue;
    headings.push({ level, index: match.index, end: headingRe.lastIndex, text });
  }

  const items = [];
  let currentH2 = null;
  let currentH3 = null;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level === 2) {
      currentH2 = h.text;
      currentH3 = null;
    }
    if (h.level === 3) currentH3 = h.text;
    if (h.level !== itemHeadingLevel) continue;

    const period = itemHeadingLevel >= 3 ? currentH2 : null;
    if (period && /^notices$/i.test(period)) continue; // long-lived plan-for-change notices, not weekly items
    const category = itemHeadingLevel >= 4 ? currentH3 : '';

    const nextStart = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const bodyText = stripHtml(html.slice(h.end, nextStart));

    items.push({
      title: h.text,
      parentCategory: category || '',
      period,
      date: parseSectionDate(period, bodyText),
    });
  }
  return items;
}

async function collectWhatsNewLiveFallback(source, seenState) {
  if (!source.itemHeadingLevel) {
    console.warn(`    Live-page fallback skipped for ${source.label}: no itemHeadingLevel configured.`);
    return [];
  }

  let html;
  try {
    const res = await fetch(source.docsUrl, { headers: { 'User-Agent': 'daily-intune-docs-reporter (+github-actions)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.warn(`    Live-page fallback skipped for ${source.label}: ${err.message}`);
    return [];
  }

  const newItems = [];
  for (const section of parseWhatsNewLivePage(html, source.itemHeadingLevel)) {
    if (!section.title) continue;

    const key = itemKey(source.label, section.title);
    const alreadySeen = Boolean(seenState.data[key]);
    seenState.touched[key] = seenState.data[key] || (section.date || new Date()).toISOString();

    if (alreadySeen || seenState.isBootstrap) continue;

    let subCategory = section.parentCategory || '';
    if (!subCategory) {
      const prefixMatch = section.title.match(/^(General Availability|Public Preview|Change Announcement|Retirement)\s*[-—–:]\s*/i);
      if (prefixMatch) subCategory = prefixMatch[1];
    }
    const anchor = section.title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const commitDate = (section.date || new Date()).toISOString();

    newItems.push({
      category: source.label,
      subCategory,
      title: section.title,
      url: `${source.docsUrl}#${anchor}`,
      commitUrl: '',
      commitDate,
      dateLabel: `${section.period || new Date(commitDate).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })} · via live docs page`,
    });
  }
  return newItems;
}

async function collectWhatsNewItems(window, seenState) {
  if (!GITHUB_TOKEN) {
    console.warn('Warning: No GITHUB_TOKEN set. Unauthenticated requests are rate-limited to 60/hr and cannot access private repos.');
  }

  const items = [];

  for (const source of WHATS_NEW_SOURCES) {
    console.log(`  Checking ${source.label}: ${source.repo}/${source.path}`);
    const sourceItems = [];
    let commits = [];
    try {
      commits = await getCommitsForFile(source.repo, source.path, source.branch, window.start, window.end);
    } catch (err) {
      console.warn(`    Skipping ${source.label}: ${err.message}`);
    }

    if (commits.length === 0) {
      console.log(`    No commits found in window.`);
    } else {
      console.log(`    Found ${commits.length} commit(s).`);
    }

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
        const knownCategories = /^(app management|device configuration|device enrollment|device management|device security|intune apps|monitor and troubleshoot|role-based access control|tenant administration|scripts)$/i;
        if (section.level === 3 && knownCategories.test(section.title)) continue;

        const key = itemKey(source.label, section.title);
        if (seen.has(key)) continue;
        seen.add(key);

        // Extract sub-category from title prefix (e.g. "General Availability - ...")
        let subCategory = section.parentCategory || '';
        if (!subCategory) {
          const prefixMatch = section.title.match(/^(General Availability|Public Preview|Change Announcement|Retirement)\s*[-—–:]\s*/i);
          if (prefixMatch) subCategory = prefixMatch[1];
        }

        const anchor = section.title
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-');

        sourceItems.push({
          category: source.label,
          subCategory,
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

    // Mark everything the diff-based method found so the live-page fallback
    // (or tomorrow's run of it) never re-reports the same item.
    for (const item of sourceItems) {
      const key = itemKey(item.category, item.title);
      if (!seenState.data[key]) seenState.touched[key] = item.commitDate;
    }
    items.push(...sourceItems);

    const liveItems = await collectWhatsNewLiveFallback(source, seenState);
    const knownKeys = new Set(sourceItems.map((item) => itemKey(item.category, item.title)));
    for (const item of liveItems) {
      const key = itemKey(item.category, item.title);
      if (knownKeys.has(key)) continue;
      knownKeys.add(key);
      items.push(item);
    }
    if (liveItems.length > 0) {
      console.log(`    Live-page fallback found ${liveItems.length} additional item(s) for ${source.label}.`);
    }
  }

  items.sort((a, b) => a.category.localeCompare(b.category) || (a.subCategory || '').localeCompare(b.subCategory || '') || a.title.localeCompare(b.title));
  return items;
}

// ---------------------------------------------------------------------------
// Microsoft 365 Roadmap
// ---------------------------------------------------------------------------

const ROADMAP_RSS_URL = 'https://www.microsoft.com/en-us/microsoft-365/RoadmapFeatureRSS/';
const ROADMAP_PRODUCT_FILTERS = ['Microsoft Intune', 'Microsoft Entra', 'Windows Autopilot', 'Windows 365'];

function roadmapKey(id) {
  return `roadmap::${id}`;
}

// ---------------------------------------------------------------------------
// Roadmap live-API fallback
// ---------------------------------------------------------------------------
//
// The RSS feed above is keyed by `pubDate`, which turns out to track each
// entry's *creation* date, not the last time it was edited. Microsoft
// regularly revises existing roadmap entries (new dates, changed status)
// without that ever showing up as a fresh pubDate, so genuine updates can
// go unnoticed indefinitely. The live roadmap page is a JS app, but it's
// backed by a public, unauthenticated JSON API that exposes a real
// `modified` timestamp per entry — query it directly and diff against the
// same kind of persisted "seen" state used for the docs fallback above,
// keyed by roadmap id instead of title so genuine edits (id already seen,
// modified date changed) are caught as well as brand-new entries.

const ROADMAP_API_URL = 'https://www.microsoft.com/releasecommunications/api/v2/m365';
const ROADMAP_PAGE_URL = 'https://www.microsoft.com/en-us/microsoft-365/roadmap';

async function fetchRoadmapApiItems() {
  const filter = ROADMAP_PRODUCT_FILTERS.map((p) => `products/any(f:f eq '${p.replace(/'/g, "''")}')`).join(' or ');
  const params = new URLSearchParams({ $count: 'true', top: '100', skip: '0', filter, orderby: 'modified desc' });
  const res = await fetch(`${ROADMAP_API_URL}?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.value || [];
}

async function collectRoadmapItemsFromLiveApi(seenState) {
  let entries;
  try {
    entries = await fetchRoadmapApiItems();
  } catch (err) {
    console.warn(`  Live roadmap API fallback skipped: ${err.message}`);
    return [];
  }

  const newItems = [];
  for (const entry of entries) {
    const key = roadmapKey(entry.id);
    const lastSeenModified = seenState.data[key];
    seenState.touched[key] = entry.modified;

    if (seenState.isBootstrap) continue;
    if (lastSeenModified && lastSeenModified === entry.modified) continue; // unchanged since last run

    const product = (entry.products || []).find((p) => ROADMAP_PRODUCT_FILTERS.includes(p)) || entry.products?.[0] || 'Microsoft 365';
    const gaDate = entry.generalAvailabilityDate ? ` · GA ${entry.generalAvailabilityDate}` : '';
    const changeNote = lastSeenModified ? 'Updated' : 'New';

    newItems.push({
      id: String(entry.id),
      category: `${product} — Roadmap`,
      title: entry.title.trim(),
      url: `${ROADMAP_PAGE_URL}?id=${entry.id}`,
      commitUrl: '',
      commitDate: entry.modified,
      dateLabel: `${entry.status || ''}${gaDate} · ${changeNote} · via live roadmap`,
    });
  }
  return newItems;
}

async function collectRoadmapItems(window, seenState) {
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

    const id = body.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1];
    const updatedStr = body.match(/<a10:updated>([^<]+)<\/a10:updated>/)?.[1];
    if (id && updatedStr) seenState.touched[roadmapKey(id)] = updatedStr;

    const pubDateStr = body.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    if (!pubDateStr) continue;
    const pubDate = new Date(pubDateStr);
    if (pubDate < window.start || pubDate >= window.end) continue;

    const title = body.match(/<title>([^<]+)<\/title>/)?.[1];
    const link = body.match(/<link>([^<]+)<\/link>/)?.[1];
    const status = categories.find((c) => ['In development', 'Rolling out', 'Launched'].includes(c)) || '';
    if (!title) continue;

    items.push({
      id,
      category: `${matchedProduct} — Roadmap`,
      title,
      url: link || '',
      commitUrl: '',
      commitDate: pubDate.toISOString(),
      dateLabel: `${status} · ${pubDate.toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })}`,
    });
  }

  console.log(`  Checking M365 Roadmap: found ${items.length} item(s) in window.`);

  const liveItems = await collectRoadmapItemsFromLiveApi(seenState);
  const reportedIds = new Set(items.map((item) => item.id).filter(Boolean));
  for (const item of liveItems) {
    if (reportedIds.has(item.id)) continue;
    reportedIds.add(item.id);
    items.push(item);
  }
  if (liveItems.length > 0) {
    console.log(`  Live roadmap API fallback found ${liveItems.length} additional/updated item(s).`);
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

  let currentHeading = null;
  for (const item of items) {
    const heading = item.subCategory ? `${item.category} — ${item.subCategory}` : item.category;
    if (heading !== currentHeading) {
      currentHeading = heading;
      lines.push(`## ${heading}`);
      lines.push('');
    }
    const changeLink = item.commitUrl ? ` · [view change](${item.commitUrl})` : '';
    lines.push(`- [${item.title}](${item.url})${changeLink}`);
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

  const docsSeenState = await loadSeenState('whats-new-seen.json');
  const roadmapSeenState = await loadSeenState('roadmap-seen.json');
  if (docsSeenState.isBootstrap) console.log('No docs seen-state file yet — seeding it from the live pages without reporting a backlog.');
  if (roadmapSeenState.isBootstrap) console.log('No roadmap seen-state file yet — seeding it from the live API without reporting a backlog.');

  const docsItems = await collectWhatsNewItems(window, docsSeenState);
  console.log(`Found ${docsItems.length} docs item(s).`);

  const roadmapItems = await collectRoadmapItems(window, roadmapSeenState);

  await saveSeenState('whats-new-seen.json', docsSeenState);
  await saveSeenState('roadmap-seen.json', roadmapSeenState);

  const items = [...docsItems, ...roadmapItems];
  items.sort((a, b) => a.category.localeCompare(b.category) || (a.subCategory || '').localeCompare(b.subCategory || '') || a.title.localeCompare(b.title));
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
