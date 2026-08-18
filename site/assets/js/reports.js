(function() {
  const REPO = document.querySelector('meta[name="github-repo"]')?.content
    || 'BurgerhoutJ/daily-intune-docs-reporter';
  const LABEL = 'intune-docs-report';
  const API = `https://api.github.com/repos/${REPO}/issues`;

  function esc(s) {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  async function fetchIssues(page = 1, perPage = 30) {
    const params = new URLSearchParams({
      labels: LABEL,
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: perPage,
      page,
    });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    return res.json();
  }

  function parseBody(body) {
    const items = [];
    let currentCategory = null;
    for (const line of (body || '').split('\n')) {
      const catMatch = line.match(/^## (.+)$/);
      if (catMatch) { currentCategory = catMatch[1]; continue; }
      const itemMatch = line.match(/^- \[(.+?)\]\((.+?)\)(.*)$/);
      if (itemMatch && currentCategory) {
        items.push({ category: currentCategory, title: itemMatch[1], url: itemMatch[2] });
      }
    }
    return items;
  }

  function groupByCategory(items) {
    const groups = {};
    for (const item of items) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    }
    return groups;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  }

  function renderLatestCard(issue) {
    const items = parseBody(issue.body);
    const groups = groupByCategory(items);
    const date = formatDate(issue.created_at);

    let itemsHtml = '';
    if (items.length === 0) {
      itemsHtml = '<p class="empty">No changes were published in this window.</p>';
    } else {
      itemsHtml = Object.entries(groups).map(([cat, catItems]) => `
        <div class="category-group">
          <div class="category-name">${esc(cat)}</div>
          <ul>${catItems.map(i => `<li><a href="${esc(i.url)}">${esc(i.title)}</a></li>`).join('')}</ul>
        </div>
      `).join('');
    }

    return `
      <div class="report-card">
        <div class="card-header">
          <h2 class="card-title"><a href="${esc(issue.html_url)}">${esc(issue.title)}</a></h2>
          <span class="card-date">${date}</span>
        </div>
        <div class="card-meta">
          <span class="badge">${items.length} change${items.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="report-items">${itemsHtml}</div>
      </div>
    `;
  }

  function renderArchiveList(issues) {
    if (issues.length === 0) {
      return '<p class="empty">No reports found yet.</p>';
    }
    const items = issues.map(issue => {
      const count = parseBody(issue.body).length;
      const date = formatDate(issue.created_at);
      return `<li><a href="${esc(issue.html_url)}">
        <span class="archive-title">${esc(issue.title)}</span>
        <span class="archive-meta">
          <span class="archive-count">${count} change${count !== 1 ? 's' : ''}</span>
          <span class="archive-date">${date}</span>
        </span>
      </a></li>`;
    }).join('');
    return `<ul class="archive-list">${items}</ul>`;
  }

  // Init based on which page elements exist
  async function init() {
    const latestEl = document.getElementById('latest-report');
    const archiveEl = document.getElementById('archive-list');
    if (!latestEl && !archiveEl) return;

    try {
      const issues = await fetchIssues(1, 30);

      if (latestEl) {
        if (issues.length === 0) {
          latestEl.innerHTML = '<p class="empty">No reports yet. The first report will appear after the next scheduled run.</p>';
        } else {
          latestEl.innerHTML = renderLatestCard(issues[0]);
          // Show recent reports below (up to 5 more)
          if (issues.length > 1) {
            const recentHtml = issues.slice(1, 6).map(issue => {
              const count = parseBody(issue.body).length;
              const date = formatDate(issue.created_at);
              return `
                <div class="report-card">
                  <div class="card-header">
                    <h3 class="card-title"><a href="${esc(issue.html_url)}">${esc(issue.title)}</a></h3>
                    <span class="card-date">${date}</span>
                  </div>
                  <div class="card-meta">
                    <span class="badge">${count} change${count !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              `;
            }).join('');
            latestEl.insertAdjacentHTML('beforeend', `<h2 style="margin: 2rem 0 1rem; font-size: 1.2rem;">Recent Reports</h2>${recentHtml}`);
          }
        }
      }

      if (archiveEl) {
        archiveEl.innerHTML = renderArchiveList(issues);
      }
    } catch (err) {
      const msg = `<div class="error">Failed to load reports: ${esc(err.message)}. The GitHub API may be rate-limited for unauthenticated requests.</div>`;
      if (latestEl) latestEl.innerHTML = msg;
      if (archiveEl) archiveEl.innerHTML = msg;
    }
  }

  init();
})();
