// The Verify API's monitoring board, served at GET /status. One
// self-contained page — inline CSS, inline script, inline SVG charts — because
// Toolforge does not allow tools to load third-party resources. It polls
// /metrics.json on this origin and renders nothing the JSON doesn't already
// publish.

export const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify API status</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 14px; margin: 0 0 12px; font-weight: 600; }
.meta { color: var(--ink-2); font-size: 13px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-weight: 600; font-size: 13px; }
.badge .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.badge[data-state="ok"] .dot { background: var(--good); }
.badge[data-state="degraded"] .dot { background: var(--critical); }
.badge[data-state="down"] .dot { background: var(--warning); }
.controls { margin-left: auto; display: flex; gap: 4px; }
.controls button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--ink-2); cursor: pointer; }
.controls button[aria-pressed="true"] { color: var(--ink); font-weight: 600; border-color: var(--axis); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.tile .label { color: var(--ink-2); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
.tile .sub { color: var(--muted); font-size: 12px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-bottom: 12px; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: -4px 0 10px; font-size: 12px; color: var(--ink-2); }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; background: var(--c); }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); white-space: nowrap; display: none; z-index: 2; }
.tip b { display: block; margin-bottom: 2px; }
.tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; font-style: normal; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { color: var(--ink-2); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
.empty { color: var(--muted); padding: 12px 0; }
.bar { height: 6px; border-radius: 3px; background: var(--s1); min-width: 2px; }
footer { color: var(--muted); font-size: 12px; margin-top: 16px; }
footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Verify API</h1>
    <span class="badge" id="health" data-state="idle"><span class="dot"></span><span id="health-label">Loading…</span></span>
    <span class="meta" id="service"></span>
    <div class="controls" role="group" aria-label="Time range">
      <button type="button" data-range="1h" aria-pressed="true">Last hour</button>
      <button type="button" data-range="24h" aria-pressed="false">Last 24 h</button>
    </div>
  </header>

  <section class="tiles">
    <div class="card tile"><div class="label">Requests</div><div class="value" id="t-requests">–</div><div class="sub" id="t-requests-sub"></div></div>
    <div class="card tile"><div class="label">Answered</div><div class="value" id="t-ok">–</div><div class="sub" id="t-ok-sub"></div></div>
    <div class="card tile"><div class="label">Latency p50 / p95</div><div class="value" id="t-latency">–</div><div class="sub" id="t-latency-sub"></div></div>
    <div class="card tile"><div class="label">Rate budget left</div><div class="value" id="t-rate">–</div><div class="sub" id="t-rate-sub"></div></div>
  </section>

  <section class="card" style="margin-bottom:12px">
    <h2 id="volume-title">Requests per minute, by outcome</h2>
    <div class="legend" id="legend"></div>
    <div class="chart" id="volume"></div>
  </section>

  <section class="grid2">
    <div class="card">
      <h2 id="latency-title">Average latency per minute</h2>
      <div class="chart" id="latency"></div>
    </div>
    <div class="card">
      <h2>Verdicts and failures</h2>
      <div id="breakdown"></div>
    </div>
  </section>

  <section class="card">
    <h2>Recent requests</h2>
    <div class="scroll" id="recent"></div>
  </section>

  <footer>
    Counters live in the server process and reset when it restarts. No claim or source text is kept — only the source's hostname.
    Raw data: <a href="metrics.json">metrics.json</a> · API contract: <a href="openapi.json">openapi.json</a>
  </footer>
</main>
<script>
(function () {
  'use strict';
  var OUTCOMES = [
    ['ok', 'Answered', 'var(--s1)'],
    ['source_unavailable', 'Source unavailable (422)', 'var(--s2)'],
    ['upstream_error', 'Upstream error (5xx)', 'var(--s3)'],
    ['rate_limited', 'Rate limited (429)', 'var(--s4)'],
    ['rejected', 'Rejected (4xx)', 'var(--s5)']
  ];
  var HEALTH = {
    ok: 'Healthy', degraded: 'Degraded', idle: 'Idle', down: 'Unreachable'
  };
  var range = '1h';
  var data = null;
  try { range = localStorage.getItem('verify-status-range') || '1h'; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMs(ms) { return ms == null ? '–' : ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + ' s' : ms + ' ms'; }
  function fmtPct(n, d) { return d ? Math.round((n / d) * 100) + '%' : '–'; }
  function fmtTime(iso, withDate) {
    var d = new Date(iso);
    return withDate ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDuration(s) {
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
  }
  function ago(iso) {
    if (!iso) return 'never';
    var s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }

  function attachHover(el, svg, n, x0, bw, html) {
    var tip = el.querySelector('.tip');
    svg.addEventListener('mousemove', function (ev) {
      var r = svg.getBoundingClientRect();
      var vbW = svg.viewBox.baseVal.width;
      var x = (ev.clientX - r.left) * vbW / r.width;
      var i = Math.floor((x - x0) / bw);
      if (i < 0 || i >= n) { tip.style.display = 'none'; return; }
      tip.innerHTML = html(i);
      tip.style.display = 'block';
      var left = ev.clientX - r.left + 12;
      if (left + tip.offsetWidth > r.width) left = ev.clientX - r.left - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, ev.clientY - r.top - tip.offsetHeight - 8) + 'px';
      var cross = svg.querySelector('.cross');
      if (cross) { cross.setAttribute('x', x0 + i * bw); cross.setAttribute('width', bw); cross.style.display = ''; }
    });
    svg.addEventListener('mouseleave', function () {
      tip.style.display = 'none';
      var cross = svg.querySelector('.cross');
      if (cross) cross.style.display = 'none';
    });
  }

  function axes(W, H, L, T, B, max, fmt, series, withDate) {
    var out = '';
    for (var k = 0; k <= 4; k++) {
      var y = T + (H - T - B) * (1 - k / 4);
      out += '<line x1="' + L + '" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="var(--' + (k ? 'grid' : 'axis') + ')" stroke-width="1"/>';
      out += '<text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + fmt(max * k / 4) + '</text>';
    }
    var bw = (W - L) / series.length;
    var every = Math.ceil(series.length / (W < 700 ? 4 : 6));
    for (var i = 0; i < series.length; i += every) {
      out += '<text x="' + (L + i * bw) + '" y="' + (H - 4) + '">' + fmtTime(series[i].start, withDate && i === 0) + '</text>';
    }
    return out;
  }

  function renderVolume(series, withDate) {
    var el = $('volume');
    var W = Math.max(280, el.clientWidth || 1000), H = 240, L = 36, T = 8, B = 22;
    var max = niceMax(Math.max.apply(null, series.map(function (s) { return s.requests; })));
    var bw = (W - L) / series.length;
    var gap = bw > 6 ? 2 : 1;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Requests by outcome over time">';
    svg += axes(W, H, L, T, B, max, function (v) { return Math.round(v); }, series, withDate);
    svg += '<rect class="cross" y="' + T + '" height="' + (H - T - B) + '" fill="var(--grid)" opacity="0.5" style="display:none"/>';
    var plotH = H - T - B;
    series.forEach(function (s, i) {
      var y = H - B;
      var x = L + i * bw + gap / 2;
      var w = Math.max(1, bw - gap);
      var drawn = OUTCOMES.filter(function (o) { return s.outcomes[o[0]]; });
      drawn.forEach(function (o, j) {
        var h = s.outcomes[o[0]] / max * plotH;
        var top = j === drawn.length - 1;
        var segH = Math.max(0, h - (top ? 0 : 1));
        y -= h;
        var r = top ? Math.min(4, w / 2, segH) : 0;
        svg += top
          ? '<path d="M' + x + ',' + (y + segH) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + segH) + 'Z" fill="' + o[2] + '"/>'
          : '<rect x="' + x + '" y="' + (y + 1) + '" width="' + w + '" height="' + segH + '" fill="' + o[2] + '"/>';
      });
    });
    svg += '</svg><div class="tip"></div>';
    el.innerHTML = svg;
    attachHover(el, el.querySelector('svg'), series.length, L, bw, function (i) {
      var s = series[i];
      var rows = OUTCOMES.filter(function (o) { return s.outcomes[o[0]]; }).map(function (o) {
        return '<div><i style="background:' + o[2] + '"></i>' + esc(o[1]) + ': ' + s.outcomes[o[0]] + '</div>';
      }).join('');
      return '<b>' + fmtTime(s.start, withDate) + ' · ' + s.requests + ' request' + (s.requests === 1 ? '' : 's') + '</b>' + (rows || '<div>No requests</div>');
    });
  }

  function renderLatency(series, withDate) {
    var el = $('latency');
    var W = Math.max(280, el.clientWidth || 460), H = 220, L = 44, T = 8, B = 22;
    var vals = series.map(function (s) { return s.avg_latency_ms; });
    var present = vals.filter(function (v) { return v != null; });
    if (!present.length) { el.innerHTML = '<div class="empty">No verifications in this range.</div>'; return; }
    var max = niceMax(Math.max.apply(null, present));
    var bw = (W - L) / series.length;
    var plotH = H - T - B;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Average latency over time">';
    svg += axes(W, H, L, T, B, max, function (v) { return fmtMs(Math.round(v)); }, series, withDate);
    svg += '<rect class="cross" y="' + T + '" height="' + plotH + '" fill="var(--grid)" opacity="0.5" style="display:none"/>';
    var d = '', dots = '';
    vals.forEach(function (v, i) {
      if (v == null) { d += ' '; return; }
      var x = L + (i + 0.5) * bw, y = H - B - v / max * plotH;
      var prevGap = i === 0 || vals[i - 1] == null;
      d += (prevGap ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      var nextGap = i === vals.length - 1 || vals[i + 1] == null;
      if (prevGap && nextGap) dots += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="var(--s1)"/>';
    });
    svg += '<path d="' + d + '" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + dots;
    svg += '</svg><div class="tip"></div>';
    el.innerHTML = svg;
    attachHover(el, el.querySelector('svg'), series.length, L, bw, function (i) {
      return '<b>' + fmtTime(series[i].start, withDate) + '</b>' + (vals[i] == null ? 'No verifications' : 'Average ' + fmtMs(vals[i]));
    });
  }

  function countTable(title, obj, total) {
    var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; });
    if (!keys.length) return '';
    var max = Math.max.apply(null, keys.map(function (k) { return obj[k]; }));
    return '<table><thead><tr><th>' + esc(title) + '</th><th class="num">Count</th><th class="num">Share</th><th style="width:30%"></th></tr></thead><tbody>' +
      keys.map(function (k) {
        return '<tr><td>' + esc(k) + '</td><td class="num">' + obj[k] + '</td><td class="num">' + fmtPct(obj[k], total) +
          '</td><td><div class="bar" style="width:' + (obj[k] / max * 100) + '%"></div></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderBreakdown(w) {
    var ok = w.outcomes.ok;
    var failed = Object.keys(w.failed_stages).reduce(function (n, k) { return n + w.failed_stages[k]; }, 0);
    var html = countTable('Verdict', w.verdicts, ok);
    if (failed) html += '<div style="height:12px"></div>' + countTable('Failed stage', w.failed_stages, failed);
    var sources = Object.keys(w.sources).reduce(function (n, k) { return n + w.sources[k]; }, 0);
    if (sources) html += '<div style="height:12px"></div>' + countTable('Source given as', w.sources, sources);
    $('breakdown').innerHTML = html || '<div class="empty">No verifications in this range.</div>';
  }

  function renderRecent(recent) {
    if (!recent.length) { $('recent').innerHTML = '<div class="empty">No requests since the server started.</div>'; return; }
    var label = {};
    OUTCOMES.forEach(function (o) { label[o[0]] = o; });
    $('recent').innerHTML = '<table><thead><tr><th>Time</th><th class="num">Status</th><th>Outcome</th><th>Verdict / stage</th><th>Source</th><th class="num">Duration</th></tr></thead><tbody>' +
      recent.slice(0, 20).map(function (r) {
        var o = label[r.outcome];
        return '<tr><td>' + fmtTime(r.at) + ' <span class="meta">' + ago(r.at) + '</span></td><td class="num">' + r.status +
          '</td><td><span class="legend" style="margin:0;display:inline"><span style="--c:' + o[2] + '">' + esc(o[1]) + '</span></span></td><td>' +
          esc(r.verdict || r.stage || '') + '</td><td>' + esc(r.source === 'url' ? (r.source_host || 'URL') : r.source === 'content' ? 'text supplied' : '') +
          '</td><td class="num">' + fmtMs(r.duration_ms) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function render() {
    if (!data) return;
    var w = data.windows[range];
    var series = range === '1h' ? data.series.per_minute_1h : data.series.per_15_minutes_24h;
    var withDate = range === '24h';
    var h = data.health;
    $('health').setAttribute('data-state', h.state);
    $('health-label').textContent = HEALTH[h.state] + (h.error_share != null ? ' · ' + Math.round(h.error_share * 100) + '% errors, last ' + h.window_minutes + ' min' : '');
    $('service').textContent = data.service.model + ' via ' + data.service.provider + ' · up ' + fmtDuration(data.service.uptime_seconds) +
      ' · last success ' + ago(data.last_success_at);

    var attempted = w.requests - w.outcomes.rejected - w.outcomes.rate_limited;
    $('t-requests').textContent = w.requests;
    $('t-requests-sub').textContent = data.windows.since_start.requests + ' since start';
    $('t-ok').textContent = fmtPct(w.outcomes.ok, attempted);
    $('t-ok-sub').textContent = w.outcomes.ok + ' of ' + attempted + ' that reached the pipeline';
    $('t-latency').textContent = w.latency_ms.n ? fmtMs(w.latency_ms.p50) + ' / ' + fmtMs(w.latency_ms.p95) : '–';
    $('t-latency-sub').textContent = w.latency_ms.n ? 'max ' + fmtMs(w.latency_ms.max) + ' over ' + w.latency_ms.n + ' calls' : 'no calls';
    var rl = data.rate_limit;
    $('t-rate').textContent = rl ? rl.remaining + ' / ' + rl.limit : '–';
    $('t-rate-sub').textContent = rl ? 'shared by all callers, resets in ' + rl.reset_seconds + ' s' : '';

    $('volume-title').textContent = range === '1h' ? 'Requests per minute, by outcome' : 'Requests per 15 minutes, by outcome';
    $('latency-title').textContent = range === '1h' ? 'Average latency per minute' : 'Average latency per 15 minutes';
    renderVolume(series, withDate);
    renderLatency(series, withDate);
    renderBreakdown(w);
    renderRecent(data.recent);
  }

  $('legend').innerHTML = OUTCOMES.map(function (o) { return '<span style="--c:' + o[2] + '">' + esc(o[1]) + '</span>'; }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('[data-range]'), function (b) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-range') === range));
    b.addEventListener('click', function () {
      range = b.getAttribute('data-range');
      try { localStorage.setItem('verify-status-range', range); } catch (e) {}
      Array.prototype.forEach.call(document.querySelectorAll('[data-range]'), function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      render();
    });
  });

  function load() {
    fetch('metrics.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) { data = json; render(); })
      .catch(function () {
        $('health').setAttribute('data-state', 'down');
        $('health-label').textContent = HEALTH.down;
      });
  }
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>
`;
