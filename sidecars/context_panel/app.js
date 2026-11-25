/**
 * Native Context Panel frontend.
 * Polls /api/context with ETag caching, syncs live host CSS theme variables,
 * and opens files / subagent conversations via window.sidecar.ui.
 */
(() => {
  const POLL_MS = 1200;
  const $ = (id) => document.getElementById(id);

  const CATEGORIES = [
    { key: 'messages', label: 'Messages', color: 'var(--c-messages)', always: true },
    { key: 'agentResponses', label: 'Agent responses', color: 'var(--c-agent)', expandGroup: 'agent', always: true },
    { key: 'toolCalls', label: 'Tool calls', color: 'var(--c-tools)', expandGroup: 'tools', always: true },
    { key: 'mcpTools', label: 'MCP tools', color: 'var(--c-mcp)', targetSec: 'sec-mcp' },
    { key: 'systemTools', label: 'System tools', color: 'var(--c-sys-tools)', always: true },
    { key: 'systemPrompt', label: 'System prompt', color: 'var(--c-sys-prompt)', always: true },
    { key: 'rulesFiles', label: 'Rules & memory', color: 'var(--c-rules)', targetSec: 'sec-rules' },
    { key: 'skills', label: 'Skills', color: 'var(--c-skills)', targetSec: 'sec-skills' },
    { key: 'mcpInstructions', label: 'MCP server instructions', color: 'var(--c-mcp-inst)', targetSec: 'sec-mcp' },
    { key: 'customAgents', label: 'Custom agents', color: 'var(--c-agents)', targetSec: 'sec-agents' },
    { key: 'systemMessages', label: 'System messages', color: 'var(--c-sys-msg)' },
    { key: 'checkpointBuffer', label: 'Checkpoint buffer', color: 'var(--c-compact)', targetSec: 'sec-growth' },
  ];

  try {
    localStorage.removeItem('context_panel_limit');
  } catch {}

  const state = {
    etag: '',
    snap: null,
    workspaces: [],
    viewMode: localStorage.getItem('context_panel_view') === 'grid' ? 'grid' : 'bar',
    reqSortDesc: localStorage.getItem('context_panel_req_order') !== 'asc',
    hoveredReqIndex: null,
    pinnedReqIndex: null,
    chartGeom: null,
    fallbackConvId: new URLSearchParams(location.search).get('conversationId') || '',
    expandedInline: new Set(), // 'agent' | 'tools'
    hoverKey: null,
    timer: null,
  };

  // ---------- Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) {
      const m = v / 1000000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }

  function fmtLimit(n) {
    const v = Number(n) || 0;
    if (v === 1048576 || v === 1000000) return '1M';
    if (v === 2097152 || v === 2000000) return '2M';
    if (v === 512000 || v === 524288) return '512k';
    if (v === 256000 || v === 262144) return '256k';
    if (v === 200000) return '200k';
    if (v === 131072 || v === 128000) return '128k';
    if (v === 65536) return '64k';
    if (v === 32768) return '32k';
    if (v >= 1000000) return `${+(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${Math.round(v / 1000)}k`;
    return String(v);
  }

  function fmtPct(tokens, limit) {
    if (!limit) return '0.0%';
    return `${((tokens / limit) * 100).toFixed(1)}%`;
  }

  function fmtIdle(sec) {
    if (sec == null || !Number.isFinite(sec)) return null;
    if (sec < 60) return `+${sec}s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `+${m}m${s}s` : `+${m}m`;
    }
    return `+${(sec / 3600).toFixed(1)}h`;
  }

  function fmtClock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function hitRateTier(r) {
    if (!r) return 'cold';
    if (r.cachedTokens === 0) {
      if (r.missReason === 'cold') return 'cold';
      if (r.missReason === 'ttl') return 'warn';
      return 'bad';
    }
    if (r.hitRatio >= 75) return 'good';
    if (r.hitRatio >= 35) return 'mid';
    return 'warn';
  }

  function reasonBadgeHtml(r) {
    if (!r || !r.missReason) return '';
    if (r.missReason === 'cold') return '<span class="reason-pill cold">cold #1</span>';
    if (r.missReason === 'ttl') {
      const gap = fmtIdle(r.idleSeconds) || '>=5m';
      return `<span class="reason-pill ttl" title="Idle gap ${esc(gap)} exceeded ~5m prompt cache TTL">TTL ${esc(gap)}</span>`;
    }
    if (r.missReason === 'compacted') return '<span class="reason-pill compacted">compacted</span>';
    return '<span class="reason-pill miss" title="0% cache read despite warm interval">0% drop</span>';
  }

  const OPEN_ICON =
    '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H4a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V9.5"/><path d="M9.5 3h3.5v3.5M13 3l-5.5 5.5"/></svg>';

  const INLINE_CHEV =
    '<svg class="row-chev" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.25 2.5 7.75 6l-3.5 3.5"/></svg>';

  function openFile(path) {
    const uri = state.snap?.allowedFiles?.[path];
    if (!uri) return;
    window.sidecar?.ui?.toggleAuxPane?.({ tabType: 'fileView', uri });
  }

  function openConversation(convId) {
    if (!convId) return;
    window.sidecar?.ui?.toggleConversation?.(convId);
  }

  function jumpToSection(secId) {
    const el = $(secId);
    if (!el || el.classList.contains('hidden')) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hasSectionItems(secId, details) {
    if (!details) return false;
    switch (secId) {
      case 'sec-tools':
        return (details.totalToolCalls || details.heavyToolCalls?.length || 0) > 0;
      case 'sec-mcp':
        return (details.mcpServers?.length || 0) > 0;
      case 'sec-rules':
        return (details.rules?.length || 0) > 0;
      case 'sec-skills':
        return (details.skills?.length || 0) > 0;
      case 'sec-agents':
        return (details.spawnedSubagents?.length || 0) + (details.customAgents?.length || 0) > 0;
      case 'sec-artifacts':
        return (details.artifacts?.length || 0) > 0;
      case 'sec-growth':
        return (details.turnsHistory?.length || 0) > 0;
      default:
        return false;
    }
  }

  // ---------- Two-Way Hover Highlight Sync ----------
  function applyHoverHighlight(key) {
    state.hoverKey = key;
    document.querySelectorAll('.bar-seg, .grid-cell[data-cat]').forEach((el) => {
      if (!key) {
        el.classList.remove('dim', 'hot');
      } else if (el.dataset.cat === key) {
        el.classList.remove('dim');
        el.classList.add('hot');
      } else {
        el.classList.remove('hot');
        el.classList.add('dim');
      }
    });
    document.querySelectorAll('.cat-row[data-cat]').forEach((el) => {
      el.classList.toggle('hot', Boolean(key && el.dataset.cat === key));
    });
  }

  // ---------- Renderers ----------
  function renderVisuals(snap) {
    const limit = snap.contextLimit || 1048576;
    const barDenom = Math.max(limit, snap.usedTokens, 1);
    const activeCats = CATEGORIES.filter((c) => (snap.categories[c.key] || 0) > 0);

    // Bar view
    const bar = $('bar-wrap');
    bar.innerHTML = activeCats
      .map((c) => {
        const val = snap.categories[c.key] || 0;
        const w = Math.max(0.4, (val / barDenom) * 100);
        return `<div class="bar-seg" data-cat="${c.key}" style="width:${w.toFixed(3)}%;background:${c.color}" title="${esc(c.label)}: ${fmtTok(val)} (${fmtPct(val, limit)})"></div>`;
      })
      .join('');

    // Grid view (100 proportional cells = 1% each)
    const grid = $('grid-wrap');
    const totalCells = 100;
    const cells = [];
    for (const c of activeCats) {
      const val = snap.categories[c.key] || 0;
      const count = Math.round((val / barDenom) * totalCells);
      for (let i = 0; i < count && cells.length < totalCells; i++) {
        cells.push(`<span class="grid-cell" data-cat="${c.key}" style="background:${c.color}" title="${esc(c.label)}: ${fmtTok(val)} (${fmtPct(val, limit)})"></span>`);
      }
    }
    while (cells.length < totalCells) {
      cells.push(`<span class="grid-cell free" title="Free space: ${fmtTok(snap.freeTokens)}"></span>`);
    }
    grid.innerHTML = cells.join('');

    const isGrid = state.viewMode === 'grid';
    bar.classList.toggle('hidden', isGrid);
    grid.classList.toggle('hidden', !isGrid);
    $('view-bar-btn').classList.toggle('on', !isGrid);
    $('view-bar-btn').setAttribute('aria-pressed', String(!isGrid));
    $('view-grid-btn').classList.toggle('on', isGrid);
    $('view-grid-btn').setAttribute('aria-pressed', String(isGrid));
  }

  function renderCategoryRows(snap) {
    const limit = snap.contextLimit || 1048576;
    const cats = snap.categories;
    const details = snap.details;

    const activeHtml = [];
    for (const c of CATEGORIES) {
      const val = cats[c.key] || 0;
      if (!c.always && val === 0) continue;

      const isExpand = Boolean(c.expandGroup);
      const isExpanded = isExpand && state.expandedInline.has(c.expandGroup);
      const validTarget = c.targetSec && hasSectionItems(c.targetSec, details) ? c.targetSec : '';
      const clickable = isExpand || Boolean(validTarget);

      const a11yAttrs = clickable
        ? isExpand
          ? ` role="button" tabindex="0" aria-expanded="${isExpanded}"`
          : ` role="button" tabindex="0"`
        : '';

      activeHtml.push(`
        <div class="cat-row${clickable ? ' clickable' : ''}${isExpanded ? ' expanded' : ''}" data-cat="${c.key}"${isExpand ? ` data-expand="${c.expandGroup}"` : ''}${validTarget ? ` data-target="${validTarget}"` : ''}${a11yAttrs}>
          <span class="swatch" style="background:${c.color}"></span>
          <span class="cat-label-wrap">
            <span class="cat-label">${esc(c.label)}</span>
            ${isExpand ? INLINE_CHEV : ''}
          </span>
          <span class="cat-tok num">${fmtTok(val)}</span>
          <span class="cat-pct num">${fmtPct(val, limit)}</span>
        </div>
      `);

      if (c.key === 'agentResponses' && isExpanded) {
        activeHtml.push(`
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Replies</span></span>
            <span class="cat-tok num">${fmtTok(cats.agentReplies)}</span>
            <span class="cat-pct num">${fmtPct(cats.agentReplies, limit)}</span>
          </div>
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Thinking / reasoning</span></span>
            <span class="cat-tok num">${fmtTok(cats.agentThinking)}</span>
            <span class="cat-pct num">${fmtPct(cats.agentThinking, limit)}</span>
          </div>
        `);
      }
      if (c.key === 'toolCalls' && isExpanded) {
        activeHtml.push(`
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Tool outputs</span></span>
            <span class="cat-tok num">${fmtTok(cats.toolCallOutputs)}</span>
            <span class="cat-pct num">${fmtPct(cats.toolCallOutputs, limit)}</span>
          </div>
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Tool arguments</span></span>
            <span class="cat-tok num">${fmtTok(cats.toolCallArgs)}</span>
            <span class="cat-pct num">${fmtPct(cats.toolCallArgs, limit)}</span>
          </div>
        `);
      }
    }
    $('rows-active').innerHTML = activeHtml.join('');

    $('rows-window').innerHTML = `
      <div class="cat-row muted-row" title="Uncached tokens sent on the latest planner turn">
        <span class="swatch" style="background:var(--c-cache-delta)"></span>
        <span class="cat-label-wrap"><span class="cat-label">Since last cache</span></span>
        <span class="cat-tok num">${fmtTok(cats.sinceLastCache)}</span>
        <span class="cat-pct num">${fmtPct(cats.sinceLastCache, limit)}</span>
      </div>
      <div class="cat-row muted-row">
        <span class="swatch" style="background:var(--c-free)"></span>
        <span class="cat-label-wrap"><span class="cat-label">Free space</span></span>
        <span class="cat-tok num">${fmtTok(snap.freeTokens)}</span>
        <span class="cat-pct num">${fmtPct(snap.freeTokens, limit)}</span>
      </div>
    `;

    const defRows = [];
    if (cats.mcpDeferred > 0) {
      const target = hasSectionItems('sec-mcp', details);
      defRows.push(`
        <div class="cat-row muted-row${target ? ' clickable' : ''}"${target ? ' data-target="sec-mcp" role="button" tabindex="0"' : ''} title="Lazy MCP tool schemas on disk (0 active tokens until read)">
          <span class="swatch" style="background:var(--c-mcp);opacity:0.45"></span>
          <span class="cat-label-wrap"><span class="cat-label">MCP tools (deferred)</span></span>
          <span class="cat-tok num">${fmtTok(cats.mcpDeferred)}</span>
          <span class="cat-pct num"></span>
        </div>
      `);
    }
    if (cats.skillsDeferred > 0) {
      const target = hasSectionItems('sec-skills', details);
      defRows.push(`
        <div class="cat-row muted-row${target ? ' clickable' : ''}"${target ? ' data-target="sec-skills" role="button" tabindex="0"' : ''} title="Unread SKILL.md bodies held on disk via progressive disclosure">
          <span class="swatch" style="background:var(--c-skills);opacity:0.45"></span>
          <span class="cat-label-wrap"><span class="cat-label">Skills (deferred)</span></span>
          <span class="cat-tok num">${fmtTok(cats.skillsDeferred)}</span>
          <span class="cat-pct num"></span>
        </div>
      `);
    }
    if (cats.rulesDeferred > 0) {
      const target = hasSectionItems('sec-rules', details);
      defRows.push(`
        <div class="cat-row muted-row${target ? ' clickable' : ''}"${target ? ' data-target="sec-rules" role="button" tabindex="0"' : ''} title="On-demand rule files not yet triggered">
          <span class="swatch" style="background:var(--c-rules);opacity:0.45"></span>
          <span class="cat-label-wrap"><span class="cat-label">Rules (deferred)</span></span>
          <span class="cat-tok num">${fmtTok(cats.rulesDeferred)}</span>
          <span class="cat-pct num"></span>
        </div>
      `);
    }
    $('deferred-divider').classList.toggle('hidden', defRows.length === 0);
    $('rows-deferred').innerHTML = defRows.join('');
  }

  function renderCacheTrajectory(snap) {
    const sec = $('cache-section');
    const cache = snap.cache || {};
    const requests = Array.isArray(cache.requests) ? cache.requests : [];
    if (requests.length === 0) {
      sec.classList.add('hidden');
      state.chartGeom = null;
      return;
    }
    sec.classList.remove('hidden');

    const N = requests.length;
    if (state.pinnedReqIndex != null && state.pinnedReqIndex > N) {
      state.pinnedReqIndex = null;
    }
    if (state.hoveredReqIndex != null && state.hoveredReqIndex > N) {
      state.hoveredReqIndex = null;
    }

    $('cache-req-badge').textContent = `${N} ${N === 1 ? 'req' : 'reqs'}`;

    const latest = requests[N - 1];
    const latestTier = hitRateTier(latest);
    const sessRatio = typeof cache.sessionCacheHitRatio === 'number' ? cache.sessionCacheHitRatio : 0;
    const warmRatio = typeof cache.warmCacheHitRatio === 'number' ? cache.warmCacheHitRatio : 0;
    const hitReqs = cache.hitRequests ?? requests.filter((r) => r.cachedTokens > 0).length;
    const zeroReqs = N - hitReqs;
    const ttlMisses = cache.ttlMissRequests ?? 0;
    const unexpMisses = cache.unexpectedMissRequests ?? 0;

    const missBreakdown = [];
    if (N >= 1 && requests[0].missReason === 'cold') missBreakdown.push('1 cold');
    if (ttlMisses > 0) missBreakdown.push(`${ttlMisses} TTL`);
    if (unexpMisses > 0) missBreakdown.push(`${unexpMisses} drop`);
    const missSub = missBreakdown.length ? missBreakdown.join(' · ') : '0 drops';

    $('cache-kpi-row').innerHTML = `
      <div class="kpi-box" title="Latest request (#${latest.reqIndex}) cache hit ratio">
        <span class="kpi-label">Latest #${latest.reqIndex}</span>
        <span class="kpi-val ${latestTier === 'good' ? 'good' : latestTier === 'bad' ? 'bad' : latestTier === 'warn' ? 'warn' : ''}">${latest.hitRatio.toFixed(1)}%</span>
        <span class="kpi-sub">${fmtTok(latest.cachedTokens)} / ${fmtTok(latest.promptTokens)}</span>
      </div>
      <div class="kpi-box" title="Whole-conversation cumulative cache hit ratio across all ${N} requests">
        <span class="kpi-label">Session total</span>
        <span class="kpi-val ${sessRatio >= 70 ? 'good' : sessRatio > 0 ? '' : ''}">${sessRatio.toFixed(1)}%</span>
        <span class="kpi-sub">${fmtTok(cache.cumulativeCachedTokens || 0)} cached</span>
      </div>
      <div class="kpi-box" title="Cache hit ratio across requests #2..#${N} (excluding initial cold request #1)">
        <span class="kpi-label">Warm (#2+)</span>
        <span class="kpi-val ${N > 1 && warmRatio >= 75 ? 'good' : ''}">${N > 1 ? `${warmRatio.toFixed(1)}%` : '—'}</span>
        <span class="kpi-sub">${N > 1 ? `peak ${(cache.peakHitRatio || 0).toFixed(1)}%` : 'awaiting #2'}</span>
      </div>
      <div class="kpi-box" title="Requests with cache hit vs 0% cache read (${esc(missSub)})">
        <span class="kpi-label">Hits / Misses</span>
        <span class="kpi-val ${unexpMisses > 0 ? 'warn' : ''}">${hitReqs} / ${zeroReqs}</span>
        <span class="kpi-sub">${esc(missSub)}</span>
      </div>
    `;

    // Build responsive 1:1 SVG chart
    const wrap = $('cache-chart-wrap');
    const W = Math.max(240, Math.round(wrap.clientWidth || 336));
    const H = 134;
    const padL = 30;
    const padR = 10;
    const padT = 10;
    const padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const xOf = (idx) => (N === 1 ? padL + plotW / 2 : padL + (idx / (N - 1)) * plotW);
    const yOf = (pct) => padT + (1 - Math.max(0, Math.min(100, pct)) / 100) * plotH;

    state.chartGeom = { W, H, padL, padR, padT, padB, plotW, plotH, requests, xOf, yOf };

    const y100 = yOf(100).toFixed(1);
    const y50 = yOf(50).toFixed(1);
    const y0 = yOf(0).toFixed(1);

    const reqPts = requests.map((r, i) => `${xOf(i).toFixed(1)},${yOf(r.hitRatio).toFixed(1)}`).join(' ');
    const cumPts = requests.map((r, i) => `${xOf(i).toFixed(1)},${yOf(r.cumulativeHitRatio).toFixed(1)}`).join(' ');
    const areaPts = N > 1
      ? `${xOf(0).toFixed(1)},${y0} ${reqPts} ${xOf(N - 1).toFixed(1)},${y0}`
      : '';

    const userTurnLines = requests
      .map((r, i) => {
        if (i === 0 || !r.isUserTurnStart) return '';
        const x = xOf(i).toFixed(1);
        return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${y0}" stroke="var(--c-messages)" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="2 2.5"/>`;
      })
      .join('');

    const dense = N > 48;
    const dotsHtml = requests
      .map((r, i) => {
        const isLast = i === N - 1;
        const isNotable = Boolean(r.missReason) || isLast;
        if (dense && !isNotable && !r.isUserTurnStart) return '';
        const cx = xOf(i).toFixed(1);
        const cy = yOf(r.hitRatio).toFixed(1);
        let fill = 'var(--c-cache-hit)';
        let stroke = 'var(--cx-surface)';
        let rad = dense ? 2.2 : 2.8;
        if (r.missReason === 'cold') {
          fill = 'var(--cx-surface)';
          stroke = 'var(--cx-fg-muted)';
          rad = 2.8;
        } else if (r.missReason === 'ttl') {
          fill = 'var(--c-cache-ttl)';
          rad = 3.2;
        } else if (r.missReason === 'miss') {
          fill = 'var(--c-cache-miss)';
          rad = 3.3;
        } else if (r.missReason === 'compacted') {
          fill = 'var(--c-mcp)';
          rad = 3.2;
        }
        const halo = isLast
          ? `<circle cx="${cx}" cy="${cy}" r="6" fill="color-mix(in srgb, ${fill} 24%, transparent)"/>`
          : '';
        return `${halo}<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
      })
      .join('');

    const xAxisLabels = [];
    if (N === 1) {
      xAxisLabels.push(`<text x="${xOf(0).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="chart-axis-text">#1</text>`);
    } else {
      xAxisLabels.push(`<text x="${padL}" y="${H - 4}" text-anchor="start" class="chart-axis-text">#1</text>`);
      if (N >= 5) {
        const midIdx = Math.floor((N - 1) / 2);
        xAxisLabels.push(`<text x="${xOf(midIdx).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="chart-axis-text">#${requests[midIdx].reqIndex}</text>`);
      }
      xAxisLabels.push(`<text x="${W - padR}" y="${H - 4}" text-anchor="end" class="chart-axis-text">#${N}</text>`);
    }

    const svg = $('cache-chart-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `
      <defs>
        <linearGradient id="cacheHitArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--c-cache-hit)" stop-opacity="0.24"/>
          <stop offset="100%" stop-color="var(--c-cache-hit)" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      <line x1="${padL}" y1="${y100}" x2="${W - padR}" y2="${y100}" stroke="var(--cx-border)" stroke-dasharray="2.5 2.5"/>
      <line x1="${padL}" y1="${y50}" x2="${W - padR}" y2="${y50}" stroke="var(--cx-border)" stroke-dasharray="2.5 2.5"/>
      <line x1="${padL}" y1="${y0}" x2="${W - padR}" y2="${y0}" stroke="var(--cx-border)"/>
      <text x="${padL - 5}" y="${Number(y100) + 3}" text-anchor="end" class="chart-axis-text">100%</text>
      <text x="${padL - 5}" y="${Number(y50) + 3}" text-anchor="end" class="chart-axis-text">50%</text>
      <text x="${padL - 5}" y="${Number(y0) + 3}" text-anchor="end" class="chart-axis-text">0%</text>
      ${userTurnLines}
      ${areaPts ? `<polygon points="${areaPts}" fill="url(#cacheHitArea)"/>` : ''}
      ${N > 1 ? `<polyline points="${cumPts}" fill="none" stroke="var(--c-cache-cum)" stroke-width="1.4" stroke-dasharray="3.5 2.5" opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
      ${N > 1 ? `<polyline points="${reqPts}" fill="none" stroke="var(--c-cache-hit)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
      ${dotsHtml}
      <line id="cache-crosshair" x1="0" y1="${padT}" x2="0" y2="${y0}" stroke="var(--cx-fg-muted)" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="2 2" class="hidden"/>
      <circle id="cache-focus-cum" cx="0" cy="0" r="3" fill="var(--c-cache-cum)" stroke="var(--cx-surface)" stroke-width="1.2" class="hidden"/>
      <circle id="cache-focus-req" cx="0" cy="0" r="4.2" fill="var(--c-cache-hit)" stroke="var(--cx-surface)" stroke-width="1.6" class="hidden"/>
      ${xAxisLabels.join('')}
    `;

    // Render full per-request list (preserving scrollTop)
    const listEl = $('cache-req-list');
    const prevScroll = listEl.scrollTop;
    const maxPrompt = Math.max(1, ...requests.map((r) => r.promptTokens));
    const ordered = state.reqSortDesc ? [...requests].reverse() : requests;

    $('cache-order-btn').textContent = state.reqSortDesc ? 'Newest ↓' : '#1 → #N ↑';
    $('cache-reqs-summary').textContent = `${fmtTok(cache.cumulativeCachedTokens || 0)} / ${fmtTok(cache.cumulativeInputTokens || 0)} cached`;

    listEl.innerHTML = ordered
      .map((r) => {
        const tier = hitRateTier(r);
        const totalWidthPct = Math.max(4, Math.min(100, (r.promptTokens / maxPrompt) * 100));
        const cachedSharePct = r.promptTokens > 0 ? (r.cachedTokens / r.promptTokens) * 100 : 0;
        const uncachedSharePct = Math.max(0, 100 - cachedSharePct);
        const uncachedCls = r.missReason === 'miss' ? ' miss' : r.missReason === 'ttl' ? ' ttl' : '';
        const uBadge = r.isUserTurnStart ? `<span class="uturn-pill" title="User message #${r.userTurn}">U${r.userTurn}</span>` : '';
        let rightLabel = `${fmtTok(r.cachedTokens)}/${fmtTok(r.promptTokens)}`;
        if (r.cachedTokens === 0) {
          if (r.missReason === 'cold') rightLabel = `cold · ${fmtTok(r.promptTokens)}`;
          else if (r.missReason === 'ttl') rightLabel = `TTL · ${fmtTok(r.promptTokens)}`;
          else if (r.missReason === 'compacted') rightLabel = `cmp · ${fmtTok(r.promptTokens)}`;
          else rightLabel = `drop · ${fmtTok(r.promptTokens)}`;
        }
        return `
          <div class="req-row" data-req-index="${r.reqIndex}">
            <span class="req-id-cell">#${r.reqIndex}${uBadge}</span>
            <span class="req-bar-track" title="#${r.reqIndex}: ${fmtTok(r.cachedTokens)} cached + ${fmtTok(r.uncachedTokens)} uncached = ${fmtTok(r.promptTokens)} prompt">
              <span class="req-bar-total" style="width:${totalWidthPct.toFixed(1)}%">
                <span class="req-bar-cached" style="width:${cachedSharePct.toFixed(1)}%"></span>
                <span class="req-bar-uncached${uncachedCls}" style="width:${uncachedSharePct.toFixed(1)}%"></span>
              </span>
            </span>
            <span class="req-pct-cell ${tier}">${r.hitRatio.toFixed(1)}%</span>
            <span class="req-tok-cell">${esc(rightLabel)}</span>
          </div>
        `;
      })
      .join('');

    listEl.scrollTop = prevScroll;
    updateCacheFocus();
  }

  function updateCacheFocus() {
    const g = state.chartGeom;
    if (!g || !g.requests.length) return;
    const N = g.requests.length;
    const targetReqIndex = state.hoveredReqIndex ?? state.pinnedReqIndex ?? N;
    const idx = Math.max(0, Math.min(N - 1, targetReqIndex - 1));
    const r = g.requests[idx];

    const cx = g.xOf(idx).toFixed(1);
    const cyReq = g.yOf(r.hitRatio).toFixed(1);
    const cyCum = g.yOf(r.cumulativeHitRatio).toFixed(1);

    const cross = $('cache-crosshair');
    const dotReq = $('cache-focus-req');
    const dotCum = $('cache-focus-cum');
    if (cross && dotReq && dotCum) {
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.classList.remove('hidden');

      dotReq.setAttribute('cx', cx);
      dotReq.setAttribute('cy', cyReq);
      const tier = hitRateTier(r);
      const focusColor =
        tier === 'bad'
          ? 'var(--c-cache-miss)'
          : tier === 'warn'
            ? 'var(--c-cache-ttl)'
            : tier === 'cold'
              ? 'var(--cx-fg-muted)'
              : 'var(--c-cache-hit)';
      dotReq.setAttribute('fill', focusColor);
      dotReq.classList.remove('hidden');

      if (N > 1) {
        dotCum.setAttribute('cx', cx);
        dotCum.setAttribute('cy', cyCum);
        dotCum.classList.remove('hidden');
      } else {
        dotCum.classList.add('hidden');
      }
    }

    const tier = hitRateTier(r);
    const clock = fmtClock(r.createdAt);
    const idle = fmtIdle(r.idleSeconds);
    const toolsText = r.toolCount > 0
      ? `${r.toolCount} ${r.toolCount === 1 ? 'tool' : 'tools'} (${r.toolNames.slice(0, 2).join(', ')}${r.toolCount > 2 ? '…' : ''})`
      : 'reply';
    const isPinned = state.pinnedReqIndex === r.reqIndex;

    $('cache-inspect-bar').innerHTML = `
      <div class="inspect-left">
        <span class="inspect-req">#${r.reqIndex}</span>
        ${r.isUserTurnStart ? `<span class="uturn-pill">User #${r.userTurn}</span>` : ''}
        <span class="inspect-muted">step ${r.stepIndex}</span>
        ${clock ? `<span class="inspect-muted">· ${esc(clock)}</span>` : ''}
        ${idle ? `<span class="inspect-muted">· Δt ${esc(idle)}</span>` : ''}
        <span class="inspect-muted">· ${esc(toolsText)}</span>
        ${isPinned ? '<span class="pin-tag" title="Click chart or row again to unpin">pinned</span>' : ''}
      </div>
      <div class="inspect-right">
        ${reasonBadgeHtml(r)}
        <span class="inspect-hit ${tier}">${r.hitRatio.toFixed(1)}%</span>
        <span class="inspect-muted">(${fmtTok(r.cachedTokens)} hit + ${fmtTok(r.uncachedTokens)} new = ${fmtTok(r.promptTokens)} · cum ${r.cumulativeHitRatio.toFixed(1)}%)</span>
      </div>
    `;

    document.querySelectorAll('#cache-req-list .req-row').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.reqIndex) === r.reqIndex);
    });
  }

  function renderDetails(snap) {
    const d = snap.details;
    const allowed = snap.allowedFiles || {};
    let visibleSections = 0;

    // 1. Tool calls (heaviest)
    const toolsCount = d.totalToolCalls || d.heavyToolCalls.length;
    $('sec-tools').classList.toggle('hidden', toolsCount === 0);
    if (toolsCount > 0) visibleSections++;
    $('count-tools').textContent = String(toolsCount);
    $('body-tools').innerHTML = d.heavyToolCalls
      .map((t) => {
        const canOpen = t.path && allowed[t.path];
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name" title="${esc(t.label)}">${esc(t.label)}</span>
              <span class="badge">step ${t.stepIndex}</span>
            </div>
            <div class="item-right">
              <span class="item-tok num">${fmtTok(t.tokens)}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(t.path)}" title="Open file">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 2. MCP tools (preserve inner server <details> open states)
    const openServers = new Set(
      [...$('body-mcp').querySelectorAll('details[open]')].map((el) => el.dataset.server)
    );
    $('sec-mcp').classList.toggle('hidden', d.mcpServers.length === 0);
    if (d.mcpServers.length > 0) visibleSections++;
    $('count-mcp').textContent = String(d.totalMcpTools);
    $('body-mcp').innerHTML = d.mcpServers
      .map((srv) => {
        const isOpen = openServers.has(srv.name) ? ' open' : '';
        const statusBadge = srv.disabled
          ? '<span class="badge warn">disabled</span>'
          : `<span class="badge">${srv.toolCount} tools</span>`;
        const toolsHtml = srv.tools
          .map((t) => {
            const canOpen = t.path && allowed[t.path];
            return `
              <div class="item-row">
                <div class="item-main">
                  <span class="item-name">${esc(t.name)}</span>
                  ${t.loaded ? '<span class="badge loaded">loaded</span>' : ''}
                </div>
                <div class="item-right">
                  <span class="item-tok num">${fmtTok(t.tokens)}</span>
                  ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(t.path)}" title="Open schema">${OPEN_ICON}</button>` : ''}
                </div>
              </div>
            `;
          })
          .join('');
        return `
          <details class="mcp-server" data-server="${esc(srv.name)}"${isOpen}>
            <summary>
              <span class="item-main">
                <span class="item-name">${esc(srv.name)}</span>
                ${statusBadge}
              </span>
              <span class="item-tok num">${fmtTok(srv.deferredTokens + srv.loadedTokens)} def</span>
            </summary>
            <div class="mcp-tools-list">${toolsHtml || '<div class="acc-empty">No cached tool schemas.</div>'}</div>
          </details>
        `;
      })
      .join('');

    // 3. Rules & memory
    $('sec-rules').classList.toggle('hidden', d.rules.length === 0);
    if (d.rules.length > 0) visibleSections++;
    $('count-rules').textContent = String(d.rules.length);
    $('body-rules').innerHTML = d.rules
      .map((r) => {
        const canOpen = r.path && allowed[r.path];
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name" title="${esc(r.path)}">${esc(r.label)}</span>
              <span class="badge">${esc(r.scope)}</span>
              ${r.loaded ? '<span class="badge loaded">active</span>' : ''}
            </div>
            <div class="item-right">
              <span class="item-tok num">${fmtTok(r.tokens)}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(r.path)}" title="Open rule">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 4. Skills (loaded first, then sorted by bodyTokens)
    const sortedSkills = [...d.skills].sort(
      (a, b) => Number(b.loaded) - Number(a.loaded) || b.bodyTokens - a.bodyTokens
    );
    $('sec-skills').classList.toggle('hidden', sortedSkills.length === 0);
    if (sortedSkills.length > 0) visibleSections++;
    $('count-skills').textContent = String(sortedSkills.length);
    $('body-skills').innerHTML = sortedSkills
      .map((sk) => {
        const canOpen = sk.path && allowed[sk.path];
        const tokLabel = sk.loaded
          ? `${fmtTok(sk.indexTokens)} idx · ${fmtTok(sk.bodyTokens)} read`
          : `${fmtTok(sk.indexTokens)} idx · ${fmtTok(sk.bodyTokens)} def`;
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name">${esc(sk.name)}</span>
              <span class="badge">${esc(sk.scope)}</span>
              ${sk.loaded ? '<span class="badge loaded">loaded</span>' : ''}
            </div>
            <div class="item-right">
              <span class="item-tok num">${tokLabel}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(sk.path)}" title="Open SKILL.md">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 5. Agents & subagents
    const agentRows = [];
    for (const sub of d.spawnedSubagents) {
      const stats = sub.stats
        ? `${sub.stats.steps} steps · ${fmtTok(sub.stats.promptTokens)}`
        : 'spawned';
      agentRows.push(`
        <div class="item-row">
          <div class="item-main">
            <span class="item-name">${esc(sub.role || sub.typeName)}</span>
            <span class="badge loaded">${esc(sub.typeName)}</span>
          </div>
          <div class="item-right">
            <span class="item-tok num">${stats}</span>
            ${sub.conversationId ? `<button type="button" class="open-btn" data-open-conv="${esc(sub.conversationId)}" title="Open subagent conversation">${OPEN_ICON}</button>` : ''}
          </div>
        </div>
      `);
    }
    for (const ag of d.customAgents) {
      const canOpen = ag.path && allowed[ag.path];
      agentRows.push(`
        <div class="item-row">
          <div class="item-main">
            <span class="item-name">${esc(ag.name)}</span>
            <span class="badge">${esc(ag.scope)}</span>
          </div>
          <div class="item-right">
            <span class="item-tok num">${fmtTok(ag.tokens)}</span>
            ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(ag.path)}" title="Open agent definition">${OPEN_ICON}</button>` : ''}
          </div>
        </div>
      `);
    }
    const agentsTotal = d.spawnedSubagents.length + d.customAgents.length;
    $('sec-agents').classList.toggle('hidden', agentsTotal === 0);
    if (agentsTotal > 0) visibleSections++;
    $('count-agents').textContent = String(agentsTotal);
    $('body-agents').innerHTML = agentRows.join('');

    // 6. Artifacts
    $('sec-artifacts').classList.toggle('hidden', d.artifacts.length === 0);
    if (d.artifacts.length > 0) visibleSections++;
    $('count-artifacts').textContent = String(d.artifacts.length);
    $('body-artifacts').innerHTML = d.artifacts
      .map((a) => {
        const canOpen = a.path && allowed[a.path];
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name">${esc(a.name)}</span>
            </div>
            <div class="item-right">
              <span class="item-tok num">${fmtTok(a.tokens)}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(a.path)}" title="Open artifact">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 7. Context growth sparkline & turns
    const turns = d.turnsHistory || [];
    $('sec-growth').classList.toggle('hidden', turns.length === 0);
    if (turns.length > 0) {
      visibleSections++;
      $('count-growth').textContent = `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`;
      const maxPrompt = Math.max(1, ...turns.map((t) => t.promptTokens));
      const w = 320;
      const h = 68;
      const pts = turns
        .map((t, i) => {
          const x = turns.length === 1 ? w / 2 : (i / (turns.length - 1)) * (w - 8) + 4;
          const y = h - 6 - (t.promptTokens / maxPrompt) * (h - 14);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      const areaPts = turns.length > 1
        ? `4,${h - 4} ${pts} ${(w - 4).toFixed(1)},${h - 4}`
        : '';
      const dots = turns
        .filter((t) => t.compacted)
        .map((t) => {
          const idx = turns.indexOf(t);
          const x = turns.length === 1 ? w / 2 : (idx / (turns.length - 1)) * (w - 8) + 4;
          const y = h - 6 - (t.promptTokens / maxPrompt) * (h - 14);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--c-mcp)"/>`;
        })
        .join('');

      const chartSvg = `
        <svg class="growth-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
          ${areaPts ? `<polygon points="${areaPts}" fill="color-mix(in srgb, var(--c-messages) 14%, transparent)"/>` : ''}
          ${turns.length > 1 ? `<polyline points="${pts}" fill="none" stroke="var(--c-messages)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
          ${dots}
        </svg>
      `;

      const listHtml = [...turns]
        .reverse()
        .slice(0, 20)
        .map((t) => {
          const pct = Math.min(100, (t.promptTokens / maxPrompt) * 100);
          return `
            <div class="turn-row">
              <span>step ${t.stepIndex}</span>
              <span class="turn-bar-bg"><span class="turn-bar-fill${t.compacted ? ' compacted' : ''}" style="width:${pct.toFixed(1)}%"></span></span>
              <span>${fmtTok(t.promptTokens)}${t.compacted ? ' · compacted' : ''}</span>
            </div>
          `;
        })
        .join('');

      $('body-growth').innerHTML = `${chartSvg}<div class="growth-turns">${listHtml}</div>`;
    }

    $('accordions').classList.toggle('hidden', visibleSections === 0);
  }

  function render(snap) {
    state.snap = snap;
    $('loading').classList.add('hidden');

    if (!snap || !snap.found) {
      $('panel').classList.add('hidden');
      $('empty').classList.remove('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    $('panel').classList.remove('hidden');

    $('used-pct').textContent = `${snap.usedPercent}% used`;
    $('used-tok').textContent = fmtTok(snap.usedTokens);

    const cache = snap.cache || {};
    const cacheMeta = $('cache-meta');
    if (cache.lastPromptTokens > 0) {
      const hasSess = typeof cache.sessionCacheHitRatio === 'number' && (snap.plannerTurnCount || 0) > 1;
      const sessHtml = hasSess
        ? ` <span class="cache-sub">· ${esc(cache.sessionCacheHitRatio)}% session</span>`
        : '';
      $('cache-val').innerHTML = `${esc(cache.cacheHitRatio)}% (${esc(fmtTok(cache.cachedTokens))})${sessHtml}`;
      if (cacheMeta) {
        const sessTip = hasSess
          ? ` · Session total: ${fmtTok(cache.cumulativeCachedTokens || 0)} / ${fmtTok(cache.cumulativeInputTokens || 0)} cached (${cache.sessionCacheHitRatio}%)`
          : '';
        cacheMeta.title = `Last turn: ${fmtTok(cache.cachedTokens)} / ${fmtTok(cache.lastPromptTokens)} cached (${cache.cacheHitRatio}%)${sessTip}`;
      }
    } else {
      $('cache-val').textContent = '0%';
      if (cacheMeta) cacheMeta.title = 'Prompt cache hit ratio on the latest turn';
    }

    const cpCount = snap.compaction?.count || 0;
    const cpSaved = snap.compaction?.totalSavedTokens || 0;
    const cpPill = $('checkpoint-pill');
    if (cpCount > 0) {
      cpPill.textContent = `${cpCount} ${cpCount === 1 ? 'compaction' : 'compactions'} · ${fmtTok(cpSaved)} saved`;
      cpPill.classList.remove('hidden');
    } else {
      cpPill.textContent = '';
      cpPill.classList.add('hidden');
    }

    $('limit-tok').textContent = fmtLimit(snap.contextLimit);
    const ratioGroup = $('ratio-group');
    if (ratioGroup) {
      const modelName = snap.model?.label || snap.model?.id || 'Active model';
      const maxExact = Number(snap.contextLimit || 256000).toLocaleString('en-US');
      const rawMax = Number(snap.modelMaxTokens || 0);
      const rawNote = rawMax > (snap.contextLimit || 0) ? ` (model max ${fmtLimit(rawMax)})` : '';
      ratioGroup.title = `${modelName} · ${maxExact} Antigravity limit${rawNote}`;
    }

    renderVisuals(snap);
    renderCacheTrajectory(snap);
    renderCategoryRows(snap);
    renderDetails(snap);
  }

  // ---------- Polling ----------
  async function poll(force = false) {
    const conv = window.sidecar?.conversationId || state.fallbackConvId || '';
    const qs = new URLSearchParams();
    if (conv) qs.set('conversationId', conv);
    if (state.workspaces.length) qs.set('workspaces', state.workspaces.join('|'));
    if (!force && state.etag) qs.set('etag', state.etag);

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/context?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.unchanged) return;
      state.etag = data.etag || '';
      render(data);
    } catch {
      // keep current UI state on transient sidecar reconnect
    }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = document.hidden ? 6000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedulePoll();
    }, delay);
  }

  // ---------- Event Wiring ----------
  function activateClickableRow(row) {
    if (row.dataset.expand) {
      const grp = row.dataset.expand;
      if (state.expandedInline.has(grp)) state.expandedInline.delete(grp);
      else state.expandedInline.add(grp);
      if (state.snap) renderCategoryRows(state.snap);
    }
    if (row.dataset.target) {
      jumpToSection(row.dataset.target);
    }
  }

  $('view-bar-btn').addEventListener('click', () => {
    state.viewMode = 'bar';
    localStorage.setItem('context_panel_view', 'bar');
    if (state.snap) renderVisuals(state.snap);
  });

  $('view-grid-btn').addEventListener('click', () => {
    state.viewMode = 'grid';
    localStorage.setItem('context_panel_view', 'grid');
    if (state.snap) renderVisuals(state.snap);
  });

  function resolveChartReqFromPointer(clientX) {
    const g = state.chartGeom;
    if (!g || !g.requests.length) return null;
    const rect = $('cache-chart-svg').getBoundingClientRect();
    if (!rect.width) return null;
    const relX = ((clientX - rect.left) / rect.width) * g.W;
    if (g.requests.length === 1) return 1;
    const ratio = Math.max(0, Math.min(1, (relX - g.padL) / g.plotW));
    const idx = Math.round(ratio * (g.requests.length - 1));
    return g.requests[idx]?.reqIndex ?? null;
  }

  const chartWrapEl = $('cache-chart-wrap');
  chartWrapEl.addEventListener('mousemove', (e) => {
    const reqIdx = resolveChartReqFromPointer(e.clientX);
    if (reqIdx != null && reqIdx !== state.hoveredReqIndex) {
      state.hoveredReqIndex = reqIdx;
      updateCacheFocus();
    }
  });
  chartWrapEl.addEventListener('mouseleave', () => {
    if (state.hoveredReqIndex != null) {
      state.hoveredReqIndex = null;
      updateCacheFocus();
    }
  });
  chartWrapEl.addEventListener('click', (e) => {
    const reqIdx = resolveChartReqFromPointer(e.clientX);
    if (reqIdx == null) return;
    state.pinnedReqIndex = state.pinnedReqIndex === reqIdx ? null : reqIdx;
    updateCacheFocus();
    const activeRow = document.querySelector(`#cache-req-list .req-row[data-req-index="${reqIdx}"]`);
    if (activeRow && state.pinnedReqIndex != null) {
      activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  $('cache-order-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.reqSortDesc = !state.reqSortDesc;
    localStorage.setItem('context_panel_req_order', state.reqSortDesc ? 'desc' : 'asc');
    if (state.snap) renderCacheTrajectory(state.snap);
  });

  $('cache-meta').addEventListener('click', () => {
    const sec = $('cache-section');
    if (sec && !sec.classList.contains('hidden')) {
      sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    let lastChartW = 0;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (w > 0 && Math.abs(w - lastChartW) >= 4) {
        lastChartW = w;
        if (state.snap) renderCacheTrajectory(state.snap);
      }
    }).observe(chartWrapEl);
  }

  document.addEventListener('click', (e) => {
    const fileBtn = e.target.closest('[data-open-file]');
    if (fileBtn) {
      e.stopPropagation();
      openFile(fileBtn.dataset.openFile);
      return;
    }
    const convBtn = e.target.closest('[data-open-conv]');
    if (convBtn) {
      e.stopPropagation();
      openConversation(convBtn.dataset.openConv);
      return;
    }
    const reqRow = e.target.closest('#cache-req-list .req-row');
    if (reqRow) {
      const reqIdx = Number(reqRow.dataset.reqIndex);
      if (reqIdx > 0) {
        state.pinnedReqIndex = state.pinnedReqIndex === reqIdx ? null : reqIdx;
        updateCacheFocus();
      }
      return;
    }
    const row = e.target.closest('.cat-row.clickable');
    if (row) activateClickableRow(row);
  });

  document.addEventListener('mouseover', (e) => {
    const reqRow = e.target.closest('#cache-req-list .req-row');
    if (reqRow) {
      const reqIdx = Number(reqRow.dataset.reqIndex);
      if (reqIdx > 0 && reqIdx !== state.hoveredReqIndex) {
        state.hoveredReqIndex = reqIdx;
        updateCacheFocus();
      }
    } else if (state.hoveredReqIndex != null && !e.target.closest('#cache-chart-wrap')) {
      state.hoveredReqIndex = null;
      updateCacheFocus();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest?.('.cat-row.clickable');
    if (row) {
      e.preventDefault();
      activateClickableRow(row);
    }
  });

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-cat]');
    const next = el ? el.dataset.cat : null;
    if (next !== state.hoverKey) applyHoverHighlight(next);
  });
  document.addEventListener('mouseleave', () => applyHoverHighlight(null));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      poll(false);
    }
    schedulePoll();
  });

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      state.workspaces = Array.isArray(uris) ? uris : [];
      state.etag = '';
      poll(true);
    });
  }

  // Initial boot
  (async () => {
    if (window.sidecar?.getWorkspaceUris) {
      try {
        state.workspaces = await window.sidecar.getWorkspaceUris();
      } catch {}
    }
    await poll(true);
    schedulePoll();
  })();
})();
