// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
const state = {
  events: [],
  filteredEvents: [],
  treeRoots: [],
  flatTree: [],       // flattened visible tree nodes for rendering
  stats: null,
  currentTab: 'summary',
  tableSortCol: 'seq',
  tableSortDir: 'asc',
  tableScrollTop: 0,
  selectedEventIdx: -1,
  selectedTreeNode: null,
  errorsOnlyTree: false,
  treeSearch: '',
  treeExpanded: new Set(),
  flameZoom: { start: 0, end: 1 },
  flamePan: 0,
  flameNodes: [],   // flat list of flame rects
  flameDragStart: null,
  bookmarks: new Map(),   // seq → {seq, addedAt}
  currentFileName: '',    // used as localStorage key for bookmarks
  hotspotsData: [],
  hotspotsSortCol: 'selfTime',
  hotspotsSortDir: 'desc',
  hotspotsFilter: '',
  activeHotspotFilter: null, // { ruleName, eventType }
  highlightedSeq: -1,
  flameMode: 'seq',  // 'seq' | 'self'
  smartViewEnabled: true,
  watchedProperties: [], // Array of { path: string, label: string }
  compareSelection: { first: null, second: null }, // Event objects
  dataCompleteness: { hasStepPage: false, hasParams: false },
};

const SMART_VIEW_KEY = 'pega-smart-view';
function loadSettings() {
  const saved = localStorage.getItem(SMART_VIEW_KEY);
  if (saved !== null) {
    state.smartViewEnabled = saved === 'true';
    const btn = document.getElementById('smart-toggle-btn');
    if (btn) btn.classList.toggle('active', state.smartViewEnabled);
  }
}
// Call immediately or on DOM load
document.addEventListener('DOMContentLoaded', loadSettings);

const ROW_HEIGHT = 32;

// ═══════════════════════════════════════════════════════
//  EVENT TYPE COLORS & CLASSIFICATION
// ═══════════════════════════════════════════════════════
function getEventTypeClass(et) {
  if (!et) return 'et-other';
  const l = et.toLowerCase();
  if (l.includes('activity')) return 'et-activity';
  if (l.includes('flow action') || l.includes('flow')) return 'et-flow';
  if (l.includes('db') || l.includes('database') || l.includes('sql')) return 'et-db';
  if (l.includes('decision')) return 'et-decision';
  if (l.includes('data transform') || l.includes('transform')) return 'et-dt';
  if (l.includes('connect') || l.includes('service')) return 'et-connect';
  if (l.includes('exception')) return 'et-exception';
  if (l.includes('validate') || l.includes('validation')) return 'et-validate';
  if (l.includes('step')) return 'et-step';
  return 'et-other';
}

const TYPE_COLORS = {
  'et-activity': '#89b4fa',
  'et-flow':     '#a6e3a1',
  'et-step':     '#6b7799',
  'et-db':       '#cba6f7',
  'et-decision': '#fab387',
  'et-dt':       '#f5c2e7',
  'et-connect':  '#89dceb',
  'et-exception':'#f38ba8',
  'et-validate': '#94e2d5',
  'et-other':    '#3a4466',
};

function getEventColor(et) {
  return TYPE_COLORS[getEventTypeClass(et)] || '#3a4466';
}

function isBeginEvent(et) {
  if (!et) return false;
  const l = et.toLowerCase();
  return l.endsWith(' begin') || l.endsWith('begin');
}
function isEndEvent(et) {
  if (!et) return false;
  const l = et.toLowerCase();
  return l.endsWith(' end') || l.endsWith('end');
}
function getBaseType(et) {
  if (!et) return et;
  return et.replace(/ Begin$/, '').replace(/ End$/, '').trim();
}

function formatElapsed(ms) {
  if (!ms || ms === 0) return '';
  if (ms >= 1000) return (ms/1000).toFixed(2) + 's';
  return ms.toFixed(1) + 'ms';
}
function formatDateTime(dt) {
  if (!dt) return '';
  // Format: 20160324T134350.639 GMT -> 2016-03-24 13:43:50
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return dt;
}

// ═══════════════════════════════════════════════════════
//  STREAMING PARSER
// ═══════════════════════════════════════════════════════
class PegaStreamParser {
  constructor(file, onEvent, onProgress, onDone) {
    this.file = file;
    this.onEvent = onEvent;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.buffer = '';
    this.offset = 0;
    this.chunkSize = 3 * 1024 * 1024; // 3MB chunks
    this.count = 0;
    this.cancelled = false;
  }

  start() { this._readChunk(); }
  cancel() { this.cancelled = true; }

  _readChunk() {
    if (this.cancelled) return;
    const slice = this.file.slice(this.offset, this.offset + this.chunkSize);
    const reader = new FileReader();
    reader.onload = e => this._processChunk(e.target.result);
    reader.onerror = () => this.onDone(this.count, 'Read error');
    reader.readAsText(slice, 'UTF-8');
  }

  _processChunk(text) {
    if (this.cancelled) return;
    this.buffer += text;
    this.offset += this.chunkSize;

    this._extractEvents();

    const progress = Math.min(this.offset / this.file.size, 1);
    this.onProgress(progress, this.count);

    if (this.offset < this.file.size) {
      setTimeout(() => this._readChunk(), 0);
    } else {
      this._extractEvents(true);
      this.onDone(this.count);
    }
  }

  _extractEvents(isFinal = false) {
    while (true) {
      const start = this.buffer.indexOf('<TraceEvent');
      if (start === -1) {
        this.buffer = this.buffer.length > 50 ? this.buffer.slice(-50) : this.buffer;
        break;
      }

      let tagEnd = -1;
      let selfClose = false;
      let inQ = false;
      for (let i = start + 11; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === '"') { inQ = !inQ; continue; }
        if (inQ) continue;
        if (this.buffer[i] === '/' && this.buffer[i+1] === '>') {
          tagEnd = i + 2; selfClose = true; break;
        }
        if (this.buffer[i] === '>') { tagEnd = i + 1; break; }
      }

      if (tagEnd === -1) {
        this.buffer = this.buffer.slice(start);
        break;
      }

      let eventEnd;
      if (selfClose) {
        eventEnd = tagEnd;
      } else {
        const closeIdx = this.buffer.indexOf('</TraceEvent>', tagEnd);
        if (closeIdx === -1) {
          if (isFinal) { this.buffer = ''; break; }
          this.buffer = this.buffer.slice(start);
          break;
        }
        eventEnd = closeIdx + 13;
      }

      const xmlStr = this.buffer.slice(start, eventEnd);
      this.buffer = this.buffer.slice(eventEnd);

      try {
        const ev = this._parseEvent(xmlStr);
        if (ev) {
          this.count++;
          debugCollector.ingest(ev, xmlStr);
          this.onEvent(ev);
        }
      } catch(e) { /* skip malformed */ }
    }
  }

  _parseEvent(xmlStr) {
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let m;
    const openTagEnd = xmlStr.indexOf('>');
    const openTag = openTagEnd > 0 ? xmlStr.slice(0, openTagEnd) : xmlStr;
    while ((m = attrRe.exec(openTag)) !== null) attrs[m[1]] = m[2];

    const childRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    const children = {};
    const decodeEnt = s => s
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
      .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");

    while ((m = childRe.exec(xmlStr)) !== null) {
      children[m[1]] = decodeEnt(m[2]);
    }

    const et = decodeEnt(attrs.eventType || '');
    let ks = decodeEnt(attrs.stepStatus || '');

    // Normalize step status to be case-insensitive for downstream logic
    const ksLower = ks.toLowerCase();
    if (ksLower === 'fail') ks = 'Fail';
    else if (ksLower === 'warning' || ksLower === 'warn') ks = 'Warning';

    return {
      seq:        parseInt(attrs.sequence) || 0,
      ruleNo:     attrs.ruleNumber || '',
      stepMethod: decodeEnt(attrs.stepMethod || ''),
      stepPage:   decodeEnt(attrs.stepPage || ''),
      step:       attrs.step || '',
      stepStatus: ks,
      eventType:  et,
      elapsed:    parseFloat(attrs.elapsed) || 0,
      name:       decodeEnt(attrs.name || ''),
      inskey:     decodeEnt(attrs.inskey || ''),
      keyname:    decodeEnt(attrs.keyname || ''),
      rsname:     decodeEnt(attrs.rsname || ''),
      rsvers:     attrs.rsvers || '',
      dateTime:   children.DateTime || '',
      interaction:children.Interaction || '',
      threadName: children.ThreadName || '',
      workPool:   children.WorkPool || '',
      message:    children.Message || children.ExceptionMessage || children.Status || children.DBTSQL || '',
      children:   children,
      rawXml:     xmlStr.length < 8000 ? xmlStr : xmlStr.slice(0, 8000) + '\n... [truncated]',
    };
  }
}

// ═══════════════════════════════════════════════════════
//  PROPERTY WATCHER LOGIC
// ═══════════════════════════════════════════════════════
function extractPropertyValue(ev, path) {
  if (!ev.children) return null;
  // Combine potential pages
  const content = (ev.children.StepPage || '') + (ev.children.ParameterPage || '') + (ev.children.PrimaryPage || '') + (ev.children.pxRequestor || '');
  if (!content) return null;

  // Simple tag search: <PropName>Value</PropName>
  // Path might be pxRequestor.pxUserIdentifier or just pyStatusWork
  const parts = path.split('.');
  const lastPart = parts[parts.length - 1];
  
  const re = new RegExp(`<${lastPart}>([\\s\\S]*?)<\\/${lastPart}>`);
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function computeWatchHistory(path) {
  const history = [];
  let lastVal = null;
  for (const ev of state.events) {
    const val = extractPropertyValue(ev, path);
    if (val !== null && val !== lastVal) {
      history.push({ seq: ev.seq, val: val, changed: lastVal !== null });
      lastVal = val;
    }
  }
  return history;
}

function addWatch(path) {
  if (state.watchedProperties.find(p => p.path === path)) return;
  state.watchedProperties.push({ path: path, history: computeWatchHistory(path) });
  renderWatchTab();
  showToast(`Watching property: ${path}`);
}

function removeWatch(path) {
  state.watchedProperties = state.watchedProperties.filter(p => p.path !== path);
  renderWatchTab();
}

function renderWatchTab() {
  const panel = document.getElementById('panel-watch');
  const body = document.getElementById('watch-body');
  if (!state.watchedProperties.length) {
    body.innerHTML = `<div class="watch-empty">No properties being watched.<br>Add one from the detail panel by clicking a property tag.</div>`;
    return;
  }

  let html = '';
  for (const wp of state.watchedProperties) {
    html += `
      <div class="watch-card">
        <div class="wc-header">
          <div class="wc-path">${escHtml(wp.path)}</div>
          <button class="wc-btn" onclick="removeWatch('${wp.path}')">✕ Remove</button>
        </div>
        <div class="wc-history">
    `;
    for (const h of wp.history) {
      html += `
        <div class="wh-row" onclick="showEventDetail(${h.seq})">
          <span class="wh-seq">#${h.seq}</span>
          <span class="wh-val">${escHtml(h.val)}</span>
          ${h.changed ? '<span class="wh-change">CHANGED</span>' : ''}
        </div>
      `;
    }
    html += `
        </div>
      </div>
    `;
  }
  body.innerHTML = html;
}

// ═══════════════════════════════════════════════════════
//  TREE BUILDER
// ═══════════════════════════════════════════════════════
function buildTree(events) {
  const roots = [];
  const stack = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const et = ev.eventType;

    if (isBeginEvent(et)) {
      const node = { ...ev, children: [], depth: stack.length, endSeq: ev.seq, totalElapsed: ev.elapsed };
      if (stack.length === 0) roots.push(node);
      else stack[stack.length-1].children.push(node);
      stack.push(node);

    } else if (isEndEvent(et)) {
      const base = getBaseType(et);
      let matched = false;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (getBaseType(stack[s].eventType) === base) {
          const node = stack[s];
          node.endSeq = ev.seq;
          node.totalElapsed = ev.elapsed || node.totalElapsed;
          if (ev.stepStatus && !node.stepStatus) node.stepStatus = ev.stepStatus;
          if (ev.message) node.endMessage = ev.message;
          stack.splice(s, 1);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const node = { ...ev, children: [], depth: stack.length };
        if (stack.length === 0) roots.push(node);
        else stack[stack.length-1].children.push(node);
      }
    } else {
      const node = { ...ev, children: [], depth: stack.length };
      if (stack.length === 0) roots.push(node);
      else stack[stack.length-1].children.push(node);
    }
  }

  // Second pass: calculate ownDuration (Self Time)
  function calcSelf(nodes) {
    for (const node of nodes) {
      let childSum = 0;
      if (node.children && node.children.length > 0) {
        calcSelf(node.children);
        for (const c of node.children) {
          childSum += c.totalElapsed || 0;
        }
      }
      node.ownDuration = Math.max(0, (node.totalElapsed || 0) - childSum);
    }
  }
  calcSelf(roots);

  return roots;
}

// ═══════════════════════════════════════════════════════
//  OWN DURATION PROPAGATION
// ═══════════════════════════════════════════════════════
// Copy ownDuration (and totalElapsed) from tree nodes back onto the flat
// events array so the Summary, Table etc. can access it.
function propagateOwnDuration(roots, events) {
  const seqMap = new Map(events.map(e => [e.seq, e]));
  function walk(nodes) {
    for (const n of nodes) {
      const ev = seqMap.get(n.seq);
      if (ev) {
        ev.ownDuration = n.ownDuration || 0;
        ev.totalElapsed = n.totalElapsed || ev.elapsed;
      }
      if (n.children) walk(n.children);
    }
  }
  walk(roots);
}

// ═══════════════════════════════════════════════════════
//  STATS BUILDER
// ═══════════════════════════════════════════════════════
function buildStats(events) {
  const s = {
    total: events.length,
    fails: [],
    warnings: [],
    exceptions: [],
    slowest: [],
    eventTypeCounts: {},
    threads: new Set(),
    interactions: new Set(),
    minSeq: Infinity, maxSeq: -Infinity,
    dateRange: { start: '', end: '' },
  };

  for (const ev of events) {
    const st = ev.stepStatus;
    if (st === 'Fail') s.fails.push(ev);
    else if (st === 'Warning') s.warnings.push(ev);

    const et = (ev.eventType||'').toLowerCase();
    if (et.includes('exception')) s.exceptions.push(ev);

    if (ev.ownDuration > 0 || ev.elapsed > 0) s.slowest.push(ev);

    s.eventTypeCounts[ev.eventType] = (s.eventTypeCounts[ev.eventType] || 0) + 1;
    if (ev.threadName) s.threads.add(ev.threadName);
    if (ev.interaction) s.interactions.add(ev.interaction);
    if (ev.seq < s.minSeq) { s.minSeq = ev.seq; s.dateRange.start = ev.dateTime; }
    if (ev.seq > s.maxSeq) { s.maxSeq = ev.seq; s.dateRange.end = ev.dateTime; }
  }

  s.slowest.sort((a,b) => (b.ownDuration || 0) - (a.ownDuration || 0));
  s.slowest = s.slowest.slice(0, 20);

  // Check for specialized data tags (Smart Fallback)
  state.dataCompleteness = {
    hasStepPage: events.some(e => e.children && (e.children.StepPage || e.children.PrimaryPage)),
    hasParams:   events.some(e => e.children && e.children.ParameterPage),
    hasAlerts:   events.some(e => (e.eventType||'').toLowerCase().includes('alert')),
  };

  return s;
}

// ═══════════════════════════════════════════════════════
//  SUMMARY RENDER
// ═══════════════════════════════════════════════════════
function renderSummary() {
  const panel = document.getElementById('panel-summary');
  if (!state.stats) { panel.innerHTML = '<div class="empty-msg">Load a tracer file to see the summary.</div>'; return; }
  const s = state.stats;

  const hasProblems = s.fails.length + s.exceptions.length;
  let html = '';

  html += '<div class="sum-grid">';
  html += card('TOTAL EVENTS', s.total.toLocaleString(), 'info', `${s.interactions.size} interactions`);
  html += card('FAILURES', s.fails.length, s.fails.length ? 'danger' : 'ok', 'step status = Fail');
  html += card('WARNINGS', s.warnings.length, s.warnings.length ? 'warn' : 'ok', 'step status = Warning');
  html += card('EXCEPTIONS', s.exceptions.length, s.exceptions.length ? 'danger' : 'ok', 'exception event types');
  html += card('THREADS', s.threads.size, 'purple', [...s.threads].join(', ').slice(0, 60));
  const maxElapsed = s.slowest.length ? s.slowest[0].elapsed : 0;
  html += card('SLOWEST OP', formatElapsed(maxElapsed) || 'N/A', 'info', s.slowest.length ? (s.slowest[0].keyname || '').slice(0,50) : '');
  html += card('DATE START', formatDateTime(s.dateRange.start) || 'N/A', 'info', '');
  html += card('DATE END', formatDateTime(s.dateRange.end) || 'N/A', 'info', '');
  html += '</div>';

  if (hasProblems) {
    html += `<div style="background:rgba(243,139,168,0.08);border:1px solid rgba(243,139,168,0.3);border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:11px;color:var(--red);">
      ⚠ This trace contains ${s.fails.length} failure(s) and ${s.exceptions.length} exception(s). Check the sections below for details.
    </div>`;
  } else {
    html += `<div style="background:rgba(166,227,161,0.08);border:1px solid rgba(166,227,161,0.3);border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:11px;color:var(--green);">
      ✓ No failures or exceptions detected in this trace.
    </div>`;
  }

  if (s.fails.length) {
    html += '<div class="sum-section"><h3>❌ Failed Events</h3><div class="event-list">';
    for (const ev of s.fails.slice(0, 30)) html += eventRow(ev, 'fail');
    if (s.fails.length > 30) html += `<div style="color:var(--muted);font-size:10px;text-align:center;padding:6px;">... and ${s.fails.length-30} more</div>`;
    html += '</div></div>';
  }

  if (s.exceptions.length) {
    html += '<div class="sum-section"><h3>💥 Exception Events</h3><div class="event-list">';
    for (const ev of s.exceptions.slice(0, 20)) html += eventRow(ev, 'exception');
    html += '</div></div>';
  }

  if (s.warnings.length) {
    html += '<div class="sum-section"><h3>⚠ Warnings</h3><div class="event-list">';
    for (const ev of s.warnings.slice(0, 20)) html += eventRow(ev, 'warn');
    if (s.warnings.length > 20) html += `<div style="color:var(--muted);font-size:10px;text-align:center;padding:6px;">... and ${s.warnings.length-20} more</div>`;
    html += '</div></div>';
  }

  if (s.slowest.length) {
    html += '<div class="sum-section"><h3>🐌 Top Slowest Operations (by Self Time)</h3><div class="event-list">';
    for (const ev of s.slowest.slice(0, 15)) html += eventRow(ev, '');
    html += '</div></div>';
  }

  const typeSorted = Object.entries(s.eventTypeCounts).sort((a,b) => b[1]-a[1]).slice(0, 20);
  if (typeSorted.length) {
    html += '<div class="sum-section"><h3>📊 Event Type Breakdown</h3>';
    html += '<div style="display:flex;flex-direction:column;gap:4px;">';
    const maxCount = typeSorted[0][1];
    for (const [type, count] of typeSorted) {
      const pct = (count / maxCount * 100).toFixed(0);
      const color = getEventColor(type);
      html += `<div style="display:flex;align-items:center;gap:10px;">
        <span style="min-width:190px;font-size:10px;color:${color};">${type || '(empty)'}</span>
        <div style="flex:1;height:12px;background:var(--bg3);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${color};opacity:0.7;border-radius:2px;"></div>
        </div>
        <span style="min-width:50px;text-align:right;color:var(--muted);font-size:10px;">${count.toLocaleString()}</span>
      </div>`;
    }
    html += '</div></div>';
  }

  panel.innerHTML = html;
  renderDataAudit(); // Call this AFTER setting panel.innerHTML if Audit is outside, or ENSURE it's inside.
}

function renderDataAudit() {
  const panel = document.getElementById('panel-summary');
  let auditDiv = document.getElementById('data-audit-info');
  
  if (!auditDiv) {
    auditDiv = document.createElement('div');
    auditDiv.id = 'data-audit-info';
    panel.prepend(auditDiv);
  }
  
  const dc = state.dataCompleteness;
  if (!dc) {
    auditDiv.classList.add('hidden');
    return;
  }

  auditDiv.classList.remove('hidden');

  let html = '<div style="font-weight:700;margin-bottom:8px;color:var(--text);display:flex;align-items:center;gap:6px;">🕵️ Data Intake Audit</div>';
  
  const item = (enabled, label, desc) => `
    <div class="audit-item">
      <div class="audit-dot ${enabled?'green':'red'}"></div>
      <span style="color:${enabled?'var(--text)':'var(--muted)'};">${label}</span>
      <span style="color:var(--muted);font-size:10px;margin-left:4px;">— ${desc}</span>
    </div>
  `;

  html += item(dc.hasStepPage, 'Clipboard Data', dc.hasStepPage ? 'Full page snapshots captured.' : 'StepPage missing. Diff/Watch features will be limited.');
  html += item(dc.hasParams, 'Parameter Data', dc.hasParams ? 'Parameter pages captured.' : 'ParameterPage missing.');
  
  if (!dc.hasStepPage && !dc.hasParams) {
    html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);color:var(--amber);font-size:10px;">
      💡 Tip: To enable full state investigation, check "Capture Step Page" in Pega Tracer Settings before exporting.
    </div>`;
  }
  auditDiv.innerHTML = html;
}

function card(label, value, cls, sub) {
  return `<div class="sum-card ${cls}">
    <div class="sc-label">${label}</div>
    <div class="sc-value">${value}</div>
    ${sub ? `<div class="sc-sub">${escHtml(sub)}</div>` : ''}
  </div>`;
}

function eventRow(ev, type) {
  const displayName = ev.keyname || ev.name || '';
  const statusBadge = ev.stepStatus ? `<span class="er-status ${ev.stepStatus.toLowerCase()}">${ev.stepStatus}</span>` : '';
  const etClass = getEventTypeClass(ev.eventType);
  const selfHtml = ev.ownDuration > 0
    ? `<span class="er-elapsed" style="color:var(--teal);" title="Self Time">${formatElapsed(ev.ownDuration)}</span>`
    : '';
  return `<div class="event-row ${type}" onclick="showEventDetail(${ev.seq})">
    <span class="er-seq">#${ev.seq}</span>
    <span class="er-type ${etClass}">${escHtml(ev.eventType||'')}</span>
    <span class="er-name" title="${escHtml(displayName)}">${escHtml(displayName.slice(0,80))}</span>
    ${statusBadge}
    ${selfHtml}
    <span class="er-elapsed" title="Total Elapsed">${formatElapsed(ev.elapsed)}</span>
  </div>`;
}

// ═══════════════════════════════════════════════════════
//  RULE HOTSPOTS (Aggregated performance)
// ═══════════════════════════════════════════════════════
function buildHotspots(events) {
  const map = new Map(); // key -> {ruleName, eventType, hits, totalTime, selfTime, dbTime, maxTime, minTime, slowestSeq}

  function getIoTime(node) {
    let io = 0;
    const et = (node.eventType || '').toLowerCase();
    if (et.includes('db-') || et.includes('connect-')) {
      io += (node.totalElapsed || 0);
    }
    if (node.children) {
      for (const c of node.children) io += getIoTime(c);
    }
    return io;
  }

  function walk(nodes) {
    for (const n of nodes) {
      const name = n.keyname || n.name || '(unknown)';
      const type = n.eventType || '';
      const key = name + '|' + type;

      if (!map.has(key)) {
        map.set(key, { 
          ruleName: name, eventType: type, hits: 0, 
          totalTime: 0, selfTime: 0, dbTime: 0,
          maxTime: -1, minTime: Infinity, slowestSeq: -1 
        });
      }
      const entry = map.get(key);
      const dur = (n.totalElapsed || 0);
      entry.hits++;
      entry.totalTime += dur;
      entry.selfTime += (n.ownDuration || 0);
      entry.dbTime += getIoTime(n);

      if (dur > entry.maxTime) {
        entry.maxTime = dur;
        entry.slowestSeq = n.seq;
      }
      if (dur < entry.minTime) entry.minTime = dur;

      if (n.children) walk(n.children);
    }
  }
  walk(state.treeRoots);

  const data = [...map.values()];
  data.forEach(d => { 
    d.avgTime = d.totalTime / d.hits; 
    d.variance = d.maxTime - d.minTime;
  });
  return data;
}

function onHotspotsFilterInput() {
  state.hotspotsFilter = document.getElementById('hotspots-filter').value.toLowerCase();
  renderHotspots();
}

function renderHotspots() {
  const panel = document.getElementById('panel-hotspots');
  if (!state.hotspotsData || !state.hotspotsData.length) {
    if (panel) panel.innerHTML = '<div class="empty-msg">No hotspots data. Load a tracer file first.</div>';
    return;
  }

  const rowsEl = document.getElementById('hotspots-rows');
  const countEl = document.getElementById('hotspots-count');
  
  const filtered = state.hotspotsFilter 
    ? state.hotspotsData.filter(d => d.ruleName.toLowerCase().includes(state.hotspotsFilter) || d.eventType.toLowerCase().includes(state.hotspotsFilter))
    : state.hotspotsData;

  countEl.textContent = `${filtered.length} unique rules/steps`;

  // Find max values for heatmap normalization
  const maxSelf = Math.max(...filtered.map(d => d.selfTime), 1);
  const maxTotal = Math.max(...filtered.map(d => d.totalTime), 1);
  const maxIo = Math.max(...filtered.map(d => d.dbTime), 1);

  let html = '';
  for (const d of filtered) {
    const ruleEsc = escHtml(d.ruleName);
    const typeEsc = escHtml(d.eventType);
    const wSelf = (d.selfTime / maxSelf * 100).toFixed(1);
    const wTotal = (d.totalTime / maxTotal * 100).toFixed(1);
    const wIo = (d.dbTime / maxIo * 100).toFixed(1);
    
    const isActive = state.activeHotspotFilter && 
                     state.activeHotspotFilter.ruleName === d.ruleName && 
                     state.activeHotspotFilter.eventType === d.eventType;

    html += `<div class="arow ${isActive ? 'active-focus' : ''}" onclick="focusHotspot('${ruleEsc}', '${typeEsc}')">
      <div class="atd self">
        <div class="arelative-bar self" style="width:${wSelf}%"></div>
        ${formatElapsed(d.selfTime)}
      </div>
      <div class="atd io">
        <div class="arelative-bar io" style="width:${wIo}%"></div>
        ${formatElapsed(d.dbTime)}
      </div>
      <div class="atd time">
        <div class="arelative-bar total" style="width:${wTotal}%"></div>
        ${formatElapsed(d.totalTime)}
      </div>
      <div class="atd">${d.hits.toLocaleString()}</div>
      <div class="atd mono">${formatElapsed(d.variance)}</div>
      <div class="atd bold" title="${ruleEsc}">${ruleEsc}</div>
      <div class="atd ${getEventTypeClass(d.eventType)}">${typeEsc}</div>
      <button class="ajump-btn" onclick="jumpToSlowest(${d.slowestSeq}, event)" title="Jump to slowest execution of this rule">➜</button>
    </div>`;
  }
  rowsEl.innerHTML = html;
}

function focusHotspot(ruleName, eventType) {
  state.activeHotspotFilter = { ruleName, eventType };
  
  // Show banner
  const banner = document.getElementById('hotspots-focus-banner');
  const ruleTxt = document.getElementById('hfb-rule');
  if (banner) banner.classList.remove('hidden');
  if (ruleTxt) ruleTxt.textContent = `${ruleName} (${eventType})`;

  // Re-render hotspots to show active row
  renderHotspots();

  // Apply filters to Table and Tree
  filterTable();
  renderTree();
  updateTabBadges();
}

function clearHotspotFilter() {
  state.activeHotspotFilter = null;
  const banner = document.getElementById('hotspots-focus-banner');
  if (banner) banner.classList.add('hidden');
  
  renderHotspots();
  filterTable();
  renderTree();
  updateTabBadges();
}

function jumpToSlowest(seq, event) {
  if (event) event.stopPropagation();
  state.highlightedSeq = seq;
  switchTab('tree');
  
  const node = findTreeNode(seq);
  if (node) {
    expandPathToNode(node);
    renderTree();
    showEventDetail(seq);

    setTimeout(() => {
      const el = document.querySelector(`.tree-node[data-seq="${seq}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('jump-highlight');
        setTimeout(() => el.classList.remove('jump-highlight'), 3000);
      }
    }, 150);
  }
}

function findTreeNode(seq) {
  function walk(nodes) {
    for (const n of nodes) {
      if (n.seq === seq) return n;
      if (n.children) {
        const found = walk(n.children);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(state.treeRoots);
}

function expandPathToNode(node) {
  // We don't have parent pointers in the tree, so we need a search that keeps track of the path
  function findPath(nodes, targetSeq, path) {
    for (const n of nodes) {
      if (n.seq === targetSeq) return true;
      if (n.children && n.children.length > 0) {
        path.push(n.seq);
        if (findPath(n.children, targetSeq, path)) return true;
        path.pop();
      }
    }
    return false;
  }
  const path = [];
  findPath(state.treeRoots, node.seq, path);
  for (const seq of path) state.treeExpanded.add(seq);
}

function sortHotspots(col) {
  if (state.hotspotsSortCol === col) {
    state.hotspotsSortDir = state.hotspotsSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.hotspotsSortCol = col;
    state.hotspotsSortDir = (col === 'ruleName' || col === 'eventType') ? 'asc' : 'desc';
  }

  document.querySelectorAll('.ah').forEach(ah => {
    ah.classList.remove('sorted', 'asc', 'desc');
    if (ah.dataset.col === col) {
      ah.classList.add('sorted', state.hotspotsSortDir);
    }
  });

  const dir = state.hotspotsSortDir === 'asc' ? 1 : -1;
  state.hotspotsData.sort((a,b) => {
    let av = a[col], bv = b[col];
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  renderHotspots();
}

// ═══════════════════════════════════════════════════════
//  TREE RENDER
function renderTree() {
  const body = document.getElementById('tree-body');
  if (!state.treeRoots.length) {
    body.innerHTML = '<div class="empty-msg">No tree data. Load a tracer file first.</div>';
    return;
  }

  const flat = [];
  const errOnly = state.errorsOnlyTree;

  function flatten(nodes) {
    for (const node of nodes) {
      const isHotspotMatch = state.activeHotspotFilter && 
                             (node.keyname || node.name || '') === state.activeHotspotFilter.ruleName && 
                             (node.eventType || '') === state.activeHotspotFilter.eventType;

      if (gsearch.active || state.activeHotspotFilter) {
        const matches = gsearch.active ? gsearch.matchedSeqs.has(node.seq) : isHotspotMatch;
        
        if (matches && (!errOnly || nodeHasError(node))) {
          flat.push(node);
        }
        if (node.children.length) flatten(node.children);
      } else {
        let show = true;
        if (errOnly && !nodeHasError(node)) show = false;
        if (show) {
          flat.push(node);
          if (state.treeExpanded.has(node.seq) && node.children.length) {
            flatten(node.children);
          }
        }
      }
    }
  }
  flatten(state.treeRoots);
  state.flatTree = flat;

  const totalLabel = gsearch.active
    ? `${flat.length.toLocaleString()} matched`
    : `${flat.length.toLocaleString()} visible`;
  document.getElementById('tree-count').textContent = totalLabel;

  let html = '';
  for (const node of flat) {
    html += renderTreeNode(node);
  }
  body.innerHTML = html;
}

function renderTreeNode(node) {
  const indent = node.depth * 16;
  const hasChildren = node.children && node.children.length > 0;
  const isOpen = state.treeExpanded.has(node.seq);
  const etClass = getEventTypeClass(node.eventType);
  const color = getEventColor(node.eventType);

  let rowClass = 'tree-node';
  if (node.seq === state.highlightedSeq) rowClass += ' highlighted';
  if (node.stepStatus === 'Fail') rowClass += ' fail-node';
  else if (node.stepStatus === 'Warning') rowClass += ' warn-node';
  else if ((node.eventType||'').toLowerCase().includes('exception')) rowClass += ' exc-node';

  const displayName = node.keyname || node.name || '';
  const arrowHtml = hasChildren
    ? `<span class="tn-arrow ${isOpen?'open':''}">▶</span>`
    : `<span class="tn-arrow"></span>`;

  const statusHtml = node.stepStatus
    ? `<span class="tn-status ${node.stepStatus==='Fail'?'er-status fail':'er-status warn'}">${node.stepStatus}</span>`
    : '';

  const elapsedHtml = node.totalElapsed
    ? `<span class="tn-elapsed" title="Total: ${formatElapsed(node.totalElapsed)} | Self: ${formatElapsed(node.ownDuration)}">${formatElapsed(node.totalElapsed)}<br><small style="opacity:0.6;font-size:8px;">self: ${formatElapsed(node.ownDuration)}</small></span>`
    : '';

  const childCount = hasChildren ? `<span style="color:var(--muted);font-size:9px;margin-right:6px;">(${node.children.length})</span>` : '';

  // Watch highlight
  let watchHtml = '';
  for (const wp of state.watchedProperties) {
    const entry = wp.history.find(h => h.seq === node.seq);
    if (entry && entry.changed) {
      watchHtml += `<span class="val-change-marker" title="Watched property '${wp.path}' changed value here">Δ</span>`;
      break;
    }
  }

  const tnStarCls = state.bookmarks.has(node.seq) ? 'bm-star active' : 'bm-star';
  const tnStarIcon = state.bookmarks.has(node.seq) ? '★' : '☆';

  return `<div class="${rowClass}" style="height:28px;padding-left:${indent}px;"
      onclick="treeNodeClick(${node.seq}, ${hasChildren})"
      data-seq="${node.seq}">
    <div style="width:${indent}px;flex-shrink:0;"></div>
    ${arrowHtml}
    <span class="tn-dot" style="background:${color};"></span>
    <span class="tn-type ${etClass}">${escHtml(node.eventType||'')}</span>
    <span class="tn-name" title="${escHtml(displayName)}">${escHtml(displayName.slice(0,100))}</span>
    ${childCount}
    ${statusHtml}
    ${watchHtml}
    ${elapsedHtml}
    <button class="${tnStarCls}" onclick="toggleBookmark(${node.seq}, event)" title="Toggle bookmark" style="margin-left:4px;margin-right:4px;">${tnStarIcon}</button>
  </div>`;
}

function nodeHasError(node) {
  if (node.stepStatus === 'Fail' || node.stepStatus === 'Warning') return true;
  if ((node.eventType||'').toLowerCase().includes('exception')) return true;
  if (node.children) for (const c of node.children) if (nodeHasError(c)) return true;
  return false;
}

function matchesSearch(node, q) {
  return (node.keyname||'').toLowerCase().includes(q)
    || (node.name||'').toLowerCase().includes(q)
    || (node.eventType||'').toLowerCase().includes(q)
    || (node.threadName||'').toLowerCase().includes(q);
}

function treeNodeClick(seq, hasChildren) {
  if (hasChildren) {
    if (state.treeExpanded.has(seq)) state.treeExpanded.delete(seq);
    else state.treeExpanded.add(seq);
    renderTree();
  }
  showEventDetail(seq);
}

function expandAllTree() {
  function addAll(nodes) { for (const n of nodes) { if (n.children.length) state.treeExpanded.add(n.seq); addAll(n.children); } }
  addAll(state.treeRoots);
  renderTree();
}
function collapseAllTree() { state.treeExpanded.clear(); renderTree(); }
function toggleErrorsOnly() {
  state.errorsOnlyTree = !state.errorsOnlyTree;
  document.getElementById('btn-errors-only').classList.toggle('active', state.errorsOnlyTree);
  renderTree();
}
function filterTree(val) { state.treeSearch = val; renderTree(); }

// ═══════════════════════════════════════════════════════
//  TABLE RENDER (Virtual Scroll)
// ═══════════════════════════════════════════════════════
function populateTypeFilter() {
  const sel = document.getElementById('tbl-type-filter');
  const types = [...new Set(state.events.map(e => e.eventType))].sort();
  sel.innerHTML = '<option value="">All Types</option>';
  for (const t of types) {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t || '(empty)';
    sel.appendChild(opt);
  }
}

function filterTable() {
  const basePool = gsearch.active ? gsearch.matchedEventsArr : state.events;
  const st = document.getElementById('tbl-status-filter').value;
  const ty = document.getElementById('tbl-type-filter').value;

  state.filteredEvents = basePool.filter(ev => {
    if (st) {
      if (st === 'Pass' && ev.stepStatus !== '') return false;
      else if (st !== 'Pass' && ev.stepStatus !== st) return false;
    }
    if (ty && ev.eventType !== ty) return false;

    if (state.activeHotspotFilter) {
      const matchName = (ev.keyname || ev.name || '') === state.activeHotspotFilter.ruleName;
      const matchType = (ev.eventType || '') === state.activeHotspotFilter.eventType;
      if (!matchName || !matchType) return false;
    }

    return true;
  });

  sortFilteredEvents();
  renderTableView();
}

function sortTable(col) {
  if (state.tableSortCol === col) {
    state.tableSortDir = state.tableSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.tableSortCol = col;
    state.tableSortDir = col === 'elapsed' ? 'desc' : 'asc';
  }
  document.querySelectorAll('.th').forEach(th => {
    th.classList.remove('sorted','asc','desc');
    if (th.dataset.col === col) {
      th.classList.add('sorted');
      th.classList.add(state.tableSortDir);
    }
  });
  sortFilteredEvents();
  renderTableView();
}

function sortFilteredEvents() {
  const col = state.tableSortCol;
  const dir = state.tableSortDir === 'asc' ? 1 : -1;
  state.filteredEvents.sort((a, b) => {
    let av = a[col] ?? '', bv = b[col] ?? '';
    if (col === 'seq' || col === 'elapsed' || col === 'ruleNo') {
      av = parseFloat(av) || 0; bv = parseFloat(bv) || 0;
    }
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

function renderTableView() {
  const count = state.filteredEvents.length;
  document.getElementById('tbl-count').textContent = `${count.toLocaleString()} / ${state.events.length.toLocaleString()} events`;
  const container = document.getElementById('table-container');
  container.style.height = (count * ROW_HEIGHT) + 'px';
  renderVisibleRows();
}

function renderVisibleRows() {
  const scroller = document.getElementById('table-scroller');
  const scrollTop = scroller.scrollTop;
  const clientH = scroller.clientHeight;

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const endIdx = Math.min(state.filteredEvents.length, Math.ceil((scrollTop + clientH) / ROW_HEIGHT) + 5);

  let html = '';
  for (let i = startIdx; i < endIdx; i++) {
    const ev = state.filteredEvents[i];
    if (!ev) continue;
    const y = i * ROW_HEIGHT;
    const st = ev.stepStatus;
    const rowClass = st === 'Fail' ? 'trow fail' : st === 'Warning' ? 'trow warning' : ((ev.eventType||'').toLowerCase().includes('exception') ? 'trow exception' : 'trow');
    const selected = ev.seq === state.selectedEventSeq ? ' selected' : '';
    const bookmarked = state.bookmarks.has(ev.seq) ? ' bookmarked' : '';
    const etClass = getEventTypeClass(ev.eventType);
    const starCls = state.bookmarks.has(ev.seq) ? 'bm-star active' : 'bm-star';
    const starIcon = state.bookmarks.has(ev.seq) ? '★' : '☆';
    html += `<div class="${rowClass}${selected}${bookmarked}" style="position:absolute;top:${y}px;left:0;right:0;height:${ROW_HEIGHT}px;" onclick="showEventDetail(${ev.seq})">
      <button class="${starCls}" onclick="toggleBookmark(${ev.seq}, event)" title="Toggle bookmark">${starIcon}</button>
      <div class="td seq">${ev.seq}</div>
      <div class="td" style="font-size:10px;color:var(--muted);">${formatDateTime(ev.dateTime)}</div>
      <div class="td ${etClass}">${escHtml(ev.eventType||'')}</div>
      <div class="td" title="${escHtml(ev.keyname||ev.name||'')}">${escHtml((ev.keyname||ev.name||'').slice(0,80))}</div>
      <div class="td">${escHtml(ev.step||'')}</div>
      <div class="td status-cell" style="display:flex;align-items:center;gap:4px;">
        ${st ? `<span class="er-status ${st.toLowerCase()}">${st}</span>` : ''}
        ${state.watchedProperties.some(wp => wp.history.some(h => h.seq === ev.seq && h.changed)) ? `<span class="val-change-marker" title="Watched property changed value here">Δ</span>` : ''}
      </div>
      <div class="td elapsed">${formatElapsed(ev.elapsed)}</div>
      <div class="td" style="color:var(--teal);">${formatElapsed(ev.ownDuration)}</div>
      <div class="td ${st==='Fail'?'status-fail':(st==='Warning'?'status-warn':'')} ">${escHtml(st||'')}</div>
      <div class="td" style="color:var(--muted);">${escHtml(ev.threadName||'')}</div>
    </div>`;
  }

  document.getElementById('table-rows').style.height = (state.filteredEvents.length * ROW_HEIGHT) + 'px';
  document.getElementById('table-rows').innerHTML = html;
}

function onTableScroll() { renderVisibleRows(); }

// ═══════════════════════════════════════════════════════
//  FLAMEGRAPH
// ═══════════════════════════════════════════════════════
const BAR_H = 22;
const FLAME_PAD = 2;
let flameCtx = null;
let flameMeta = { minSeq: 0, seqRange: 1, maxDepth: 0 };

function buildFlameNodes(roots) {
  const nodes = [];
  function walk(node) {
    nodes.push({
      seq: node.seq,
      endSeq: node.endSeq || node.seq,
      depth: node.depth,
      eventType: node.eventType,
      keyname: node.keyname || node.name || '',
      elapsed: node.totalElapsed || node.elapsed,
      ownDuration: node.ownDuration || 0,
      stepStatus: node.stepStatus,
      color: getEventColor(node.eventType),
    });
    if (node.children) for (const c of node.children) walk(c);
  }
  for (const r of roots) walk(r);
  return nodes;
}

function toggleFlameMode() {
  state.flameMode = state.flameMode === 'seq' ? 'self' : 'seq';
  const btn = document.getElementById('flame-mode-btn');
  if (btn) {
    btn.classList.toggle('active', state.flameMode === 'self');
  }
  const legend = document.getElementById('flame-legend');
  if (legend) {
    legend.textContent = state.flameMode === 'self'
      ? 'Each bar = one rule; width = self CPU time (excl. children); depth = call nesting; bars packed by tree order'
      : 'Each bar = one rule; width = sequence span (≈ time); depth = call nesting; left→right = chronological';
  }
  state.flameZoom = { start: 0, end: 1 };
  drawFlamegraph();
}

function drawFlamegraph() {
  if (state.flameMode === 'self') { drawFlameSelf(); return; }
  const canvas = document.getElementById('flame-canvas');
  const body = document.getElementById('flame-body');
  if (!state.flameNodes.length) {
    if (flameCtx) flameCtx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const W = body.clientWidth;
  const maxDepth = Math.max(...state.flameNodes.map(n => n.depth));
  const H = Math.max(body.clientHeight, (maxDepth + 2) * (BAR_H + FLAME_PAD) + 20);

  canvas.width = W;
  canvas.height = H;
  flameCtx = canvas.getContext('2d');

  const ctx = flameCtx;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, W, H);

  const minSeq = state.stats.minSeq;
  const seqRange = Math.max(1, state.stats.maxSeq - minSeq);
  flameMeta = { minSeq, seqRange, W, H, maxDepth };

  const z = state.flameZoom;
  const visStart = z.start * seqRange + minSeq;
  const visEnd = z.end * seqRange + minSeq;
  const visRange = Math.max(1, visEnd - visStart);

  function seqToX(seq) { return (seq - visStart) / visRange * W; }

  let drawn = 0;
  for (const n of state.flameNodes) {
    const x1 = seqToX(n.seq);
    const x2 = seqToX(n.endSeq + 1);
    const w = Math.max(1, x2 - x1);
    if (x2 < 0 || x1 > W) continue;
    if (w < 0.3) continue;

    const y = n.depth * (BAR_H + FLAME_PAD) + 10;

    let color = n.color;
    if (n.stepStatus === 'Fail') color = '#f38ba8';
    else if (n.stepStatus === 'Warning') color = '#f9e2af';

    ctx.fillStyle = color;
    ctx.globalAlpha = w < 2 ? 0.5 : 0.85;
    ctx.fillRect(x1, y, w - 1, BAR_H);

    if (w > 30) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0a0e14';
      ctx.font = '10px JetBrains Mono, monospace';
      const label = n.keyname || n.eventType || '';
      const clipped = Math.min(w - 4, W - x1 - 4);
      if (clipped > 10) {
        ctx.save();
        ctx.rect(x1 + 2, y, clipped, BAR_H);
        ctx.clip();
        ctx.fillText(label, x1 + 3, y + 14);
        ctx.restore();
      }
    }
    drawn++;
  }
  ctx.globalAlpha = 1;

  document.getElementById('flame-info').textContent = `${drawn.toLocaleString()} frames rendered | depth: ${maxDepth}`;
}

// ─── SELF TIME FLAMEGRAPH ───
// Each bar's width is proportional to ownDuration; bars at the same depth
// are packed left-to-right in their tree order. This gives a true "how much
// CPU did I own?" picture independent of sequence numbering.
let flameSelfRects = []; // [{seq, x, w, y, n}] for hit-test

function drawFlameSelf() {
  const canvas = document.getElementById('flame-canvas');
  const body = document.getElementById('flame-body');
  if (!state.flameNodes.length) {
    if (flameCtx) flameCtx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Build a per-depth layout
  // Walk the tree in original order, accumulate x offsets per depth
  const nodes = state.flameNodes;
  const totalSelf = nodes.reduce((s, n) => s + n.ownDuration, 0) || 1;
  const maxDepth = Math.max(...nodes.map(n => n.depth));

  const W = body.clientWidth;
  const H = Math.max(body.clientHeight, (maxDepth + 2) * (BAR_H + FLAME_PAD) + 20);
  canvas.width = W; canvas.height = H;
  flameCtx = canvas.getContext('2d');
  const ctx = flameCtx;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, W, H);

  // Zoom
  const z = state.flameZoom;
  const totalMs = totalSelf;
  const visStart = z.start * totalMs;
  const visEnd = z.end * totalMs;
  const visRange = Math.max(0.001, visEnd - visStart);

  // Per-depth running x cursor (in ms units, then projected to pixels)
  const cursorMs = {};

  flameSelfRects = [];
  let drawn = 0;

  // Walk in tree order (nodes were built depth-first, so parent before children)
  // We want: parent's x = sum of siblings before it at same depth slot
  // Simplest approach: assign each node an x = cursor[depth], w = ownDuration
  for (const n of nodes) {
    const d = n.depth;
    if (cursorMs[d] === undefined) cursorMs[d] = 0;

    const msStart = cursorMs[d];
    const msW = n.ownDuration || 0;
    cursorMs[d] += msW;

    // Only draw if has any self time
    if (msW < 0.01) continue;

    const x1 = Math.max(0, (msStart - visStart) / visRange * W);
    const x2 = Math.min(W, (msStart + msW - visStart) / visRange * W);
    const w = x2 - x1;
    if (w < 0.3 || x2 < 0 || x1 > W) continue;

    const y = d * (BAR_H + FLAME_PAD) + 10;

    let color = n.color;
    if (n.stepStatus === 'Fail') color = '#f38ba8';
    else if (n.stepStatus === 'Warning') color = '#f9e2af';

    ctx.fillStyle = color;
    ctx.globalAlpha = w < 2 ? 0.5 : 0.85;
    ctx.fillRect(x1, y, w - 1, BAR_H);

    if (w > 30) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0a0e14';
      ctx.font = '10px JetBrains Mono, monospace';
      const label = (n.keyname || n.eventType || '') + ' (' + formatElapsed(n.ownDuration) + ')';
      ctx.save();
      ctx.rect(x1 + 2, y, Math.max(0, w - 4), BAR_H);
      ctx.clip();
      ctx.fillText(label, x1 + 3, y + 14);
      ctx.restore();
    }

    flameSelfRects.push({ seq: n.seq, x: x1, w, y, n });
    drawn++;
  }
  ctx.globalAlpha = 1;
  flameMeta = { minSeq: 0, seqRange: 0, W, H, maxDepth, mode: 'self' };
  document.getElementById('flame-info').textContent =
    `${drawn.toLocaleString()} frames (self-time) | total self: ${formatElapsed(totalSelf)} | depth: ${maxDepth}`;
}

function flameZoomIn() {
  const mid = (state.flameZoom.start + state.flameZoom.end) / 2;
  const half = (state.flameZoom.end - state.flameZoom.start) / 4;
  state.flameZoom.start = Math.max(0, mid - half);
  state.flameZoom.end = Math.min(1, mid + half);
  drawFlamegraph();
}
function flameZoomOut() {
  const mid = (state.flameZoom.start + state.flameZoom.end) / 2;
  const half = (state.flameZoom.end - state.flameZoom.start);
  state.flameZoom.start = Math.max(0, mid - half);
  state.flameZoom.end = Math.min(1, mid + half);
  drawFlamegraph();
}
function flameReset() { state.flameZoom = { start: 0, end: 1 }; drawFlamegraph(); }

function initFlameEvents() {
  const canvas = document.getElementById('flame-canvas');
  const tooltip = document.getElementById('flame-tooltip');

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = findFlameHit(mx, my);
    if (hit) {
      document.getElementById('ft-type').textContent = hit.eventType || '';
      document.getElementById('ft-name').textContent = hit.keyname || '';
      const elapsedLabel = state.flameMode === 'self'
        ? `Self: ${formatElapsed(hit.ownDuration)} | Total: ${formatElapsed(hit.elapsed)}`
        : (hit.elapsed ? `Elapsed: ${formatElapsed(hit.elapsed)}` : '');
      document.getElementById('ft-elapsed').textContent = elapsedLabel;
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY - 10) + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = findFlameHit(mx, my);
    if (hit) showEventDetail(hit.seq);
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const pivot = mx / canvas.width;
    const factor = e.deltaY < 0 ? 0.7 : 1.4;
    const span = state.flameZoom.end - state.flameZoom.start;
    const newSpan = Math.min(1, Math.max(0.001, span * factor));
    const newStart = Math.max(0, state.flameZoom.start + (pivot * span) - (pivot * newSpan));
    const newEnd = Math.min(1, newStart + newSpan);
    state.flameZoom.start = newStart;
    state.flameZoom.end = newEnd;
    drawFlamegraph();
  }, { passive: false });

  // ── Rubber-band zoom + pan ──
  // Primary drag (left button, no Ctrl) = rubber-band box zoom
  // Ctrl+drag or middle-button = pan
  let dragState = null; // { mode:'box'|'pan', startX, startY, startZoom }

  // Overlay div for the selection box
  const selBox = document.createElement('div');
  selBox.style.cssText = 'position:absolute;pointer-events:none;border:2px solid var(--blue);background:rgba(137,180,250,0.12);display:none;';
  document.getElementById('flame-canvas-wrap').appendChild(selBox);

  canvas.addEventListener('mousedown', e => {
    if (e.button === 1) e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const isPan = e.button === 1 || e.button === 2 || e.ctrlKey || e.metaKey;
    dragState = {
      mode: isPan ? 'pan' : 'box',
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      clientStartX: e.clientX,
      startZoom: { ...state.flameZoom },
    };
    if (!isPan) {
      selBox.style.left = dragState.startX + 'px';
      selBox.style.top = '0px';
      selBox.style.width = '0px';
      selBox.style.height = canvas.height + 'px';
      selBox.style.display = 'block';
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!dragState) return;
    const rect = canvas.getBoundingClientRect();
    const curX = e.clientX - rect.left;

    if (dragState.mode === 'pan') {
      const dx = e.clientX - dragState.clientStartX;
      const span = dragState.startZoom.end - dragState.startZoom.start;
      const delta = -dx / (canvas.width || 800) * span;
      const ns = Math.max(0, dragState.startZoom.start + delta);
      const ne = Math.min(1, dragState.startZoom.end + delta);
      if (ne - ns >= span * 0.999) {
        state.flameZoom.start = ns;
        state.flameZoom.end = ne;
        drawFlamegraph();
      }
    } else {
      // rubber-band: update selection box
      const x1 = Math.min(dragState.startX, curX);
      const x2 = Math.max(dragState.startX, curX);
      selBox.style.left = x1 + 'px';
      selBox.style.width = (x2 - x1) + 'px';
    }
  });

  function endDrag(e) {
    if (!dragState) return;
    const rect = canvas.getBoundingClientRect();
    const curX = e.clientX - rect.left;

    if (dragState.mode === 'box') {
      selBox.style.display = 'none';
      const x1 = Math.min(dragState.startX, curX);
      const x2 = Math.max(dragState.startX, curX);
      const W = canvas.width || 800;
      if (x2 - x1 > 4) {
        // Map pixel range to zoom range
        const z = dragState.startZoom;
        const span = z.end - z.start;
        const newStart = z.start + (x1 / W) * span;
        const newEnd   = z.start + (x2 / W) * span;
        state.flameZoom.start = Math.max(0, newStart);
        state.flameZoom.end   = Math.min(1, newEnd);
        drawFlamegraph();
      }
    }
    dragState = null;
  }

  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', endDrag);
}

function findFlameHit(mx, my) {
  if (!flameMeta.W) return null;

  if (state.flameMode === 'self') {
    // In self-time mode, hit-test against the flameSelfRects list
    const depth = Math.floor((my - 10) / (BAR_H + FLAME_PAD));
    for (let i = flameSelfRects.length - 1; i >= 0; i--) {
      const r = flameSelfRects[i];
      if (r.n.depth === depth && mx >= r.x && mx <= r.x + r.w) return r.n;
    }
    return null;
  }

  // Sequence-span mode (original)
  const { minSeq, seqRange, W } = flameMeta;
  const z = state.flameZoom;
  const visStart = z.start * seqRange + minSeq;
  const visEnd = z.end * seqRange + minSeq;
  const visRange = Math.max(1, visEnd - visStart);
  const depth = Math.floor((my - 10) / (BAR_H + FLAME_PAD));
  const seq = Math.floor(visStart + (mx / W) * visRange);

  for (let i = state.flameNodes.length - 1; i >= 0; i--) {
    const n = state.flameNodes[i];
    if (n.depth === depth && n.seq <= seq && seq <= n.endSeq) return n;
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  XML FORMATTER + SYNTAX HIGHLIGHTER
// ═══════════════════════════════════════════════════════
function xmlTokenize(xmlStr) {
  const tokens = [];
  let i = 0;
  while (i < xmlStr.length) {
    if (xmlStr[i] === '<') {
      if (xmlStr.startsWith('<!--', i)) {
        const end = xmlStr.indexOf('-->', i + 4);
        const j = end === -1 ? xmlStr.length : end + 3;
        tokens.push({ kind: 'comment', raw: xmlStr.slice(i, j) });
        i = j; continue;
      }
      if (xmlStr.startsWith('<![CDATA[', i)) {
        const end = xmlStr.indexOf(']]>', i + 9);
        const j = end === -1 ? xmlStr.length : end + 3;
        tokens.push({ kind: 'cdata', raw: xmlStr.slice(i, j) });
        i = j; continue;
      }
      if (xmlStr.startsWith('<?', i)) {
        const end = xmlStr.indexOf('?>', i + 2);
        const j = end === -1 ? xmlStr.length : end + 2;
        tokens.push({ kind: 'decl', raw: xmlStr.slice(i, j) });
        i = j; continue;
      }
      let j = i + 1, inQ = false, qCh = '';
      while (j < xmlStr.length) {
        if (inQ) {
          if (xmlStr[j] === qCh) inQ = false;
        } else {
          const c = xmlStr[j];
          if (c === '"' || c === "'") { inQ = true; qCh = c; }
          else if (c === '>') { j++; break; }
        }
        j++;
      }
      const raw = xmlStr.slice(i, j);
      if (raw.startsWith('</'))       tokens.push({ kind: 'close',     raw });
      else if (raw.endsWith('/>'))    tokens.push({ kind: 'selfclose', raw });
      else                            tokens.push({ kind: 'open',      raw });
      i = j;
    } else {
      const j = xmlStr.indexOf('<', i);
      const end = j === -1 ? xmlStr.length : j;
      const text = xmlStr.slice(i, end).trim();
      if (text) tokens.push({ kind: 'text', raw: text });
      i = end;
    }
  }
  return tokens;
}

function collapseInline(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const a = tokens[i], b = tokens[i+1], c = tokens[i+2];
    if (a && b && c && a.kind === 'open' && b.kind === 'text' && c.kind === 'close') {
      const nameA = a.raw.match(/^<([\w:-]+)/)?.[1];
      const nameC = c.raw.match(/^<\/([\w:-]+)>/)?.[1];
      if (nameA && nameA === nameC) {
        out.push({ kind: 'inline', raw: `<${nameA}>${b.raw}</${nameC}>` });
        i += 3; continue;
      }
    }
    out.push(a); i++;
  }
  return out;
}

function expandTagAttrs(tagStr, pad, ind) {
  const selfClose = tagStr.endsWith('/>');
  const inner = selfClose ? tagStr.slice(1, -2) : tagStr.slice(1, -1);
  const spaceIdx = inner.search(/\s/);
  if (spaceIdx === -1) return pad + tagStr;

  const tagName = inner.slice(0, spaceIdx);
  const attrsStr = inner.slice(spaceIdx).trim();
  const attrs = [];
  const re = /([\w:-]+)\s*=\s*(["'][^"']*["'])/g;
  let m;
  while ((m = re.exec(attrsStr)) !== null) attrs.push(`${m[1]}=${m[2]}`);

  if (attrs.length < 3 && tagStr.length <= 100) return pad + tagStr;

  const attrPad = pad + ind;
  const result = [`${pad}<${tagName}`];
  for (const attr of attrs) result.push(`${attrPad}${attr}`);
  result.push(`${pad}${selfClose ? '/>' : '>'}`);
  return result.join('\n');
}

function prettyPrintXml(xmlStr) {
  if (!xmlStr) return '';
  const tokens = collapseInline(xmlTokenize(xmlStr));
  const IND = '  ';
  let depth = 0;
  const lines = [];

  for (const tok of tokens) {
    const pad = IND.repeat(depth);
    if (tok.kind === 'close') {
      depth = Math.max(0, depth - 1);
      lines.push(IND.repeat(depth) + tok.raw);
    } else if (tok.kind === 'open') {
      lines.push(expandTagAttrs(tok.raw, pad, IND));
      depth++;
    } else if (tok.kind === 'selfclose') {
      lines.push(expandTagAttrs(tok.raw, pad, IND));
    } else {
      lines.push(pad + tok.raw);
    }
  }
  return lines.join('\n');
}

function colorInlineAttrs(attrStr) {
  let out = '', last = 0;
  const re = /(\s+)([\w:-]+)(=)(["'])([^"']*)(["'])/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    out += escHtml(attrStr.slice(last, m.index));
    out += escHtml(m[1]);
    out += `<span class="xml-attr-name">${escHtml(m[2])}</span>`;
    out += `<span class="xml-punct">${escHtml(m[3])}</span>`;
    out += `<span class="xml-attr-quote">${escHtml(m[4])}</span>`;
    out += `<span class="xml-attr-val">${escHtml(m[5])}</span>`;
    out += `<span class="xml-attr-quote">${escHtml(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  out += escHtml(attrStr.slice(last));
  return out;
}

function hlXmlLine(line) {
  const t = line.trimStart();
  const sp = escHtml(line.slice(0, line.length - t.length));

  if (t.startsWith('<!--'))
    return sp + `<span class="xml-comment">${escHtml(t)}</span>`;

  if (t.startsWith('<![CDATA[') || t.startsWith(']]>'))
    return sp + `<span class="xml-cdata">${escHtml(t)}</span>`;

  if (t === '>' || t === '/>')
    return sp + `<span class="xml-punct">${escHtml(t)}</span>`;

  const cm = t.match(/^<\/([\w:-]+)>(.*)/);
  if (cm)
    return sp +
      `<span class="xml-punct">&lt;/</span>` +
      `<span class="xml-tag">${escHtml(cm[1])}</span>` +
      `<span class="xml-punct">&gt;</span>` +
      escHtml(cm[2]);

  const im = t.match(/^<([\w:-]+)>(.*?)<\/([\w:-]+)>(.*)$/);
  if (im && im[1] === im[3])
    return sp +
      `<span class="xml-punct">&lt;</span><span class="xml-tag">${escHtml(im[1])}</span><span class="xml-punct">&gt;</span>` +
      `<span class="xml-text">${escHtml(im[2])}</span>` +
      `<span class="xml-punct">&lt;/</span><span class="xml-tag">${escHtml(im[3])}</span><span class="xml-punct">&gt;</span>` +
      escHtml(im[4]);

  const om = t.match(/^<([\w:-]+)([\s\S]*)$/);
  if (om) {
    const rest = om[2];
    const trailMatch = rest.match(/^([\s\S]*?)(\s*\/?>)$/);
    if (trailMatch) {
      return sp +
        `<span class="xml-punct">&lt;</span>` +
        `<span class="xml-tag">${escHtml(om[1])}</span>` +
        colorInlineAttrs(trailMatch[1]) +
        `<span class="xml-punct">${escHtml(trailMatch[2])}</span>`;
    }
    return sp +
      `<span class="xml-punct">&lt;</span>` +
      `<span class="xml-tag">${escHtml(om[1])}</span>` +
      colorInlineAttrs(rest);
  }

  const am = t.match(/^([\w:-]+)(=)(["'])([\s\S]*)(["'])$/);
  if (am)
    return sp +
      `<span class="xml-attr-name">${escHtml(am[1])}</span>` +
      `<span class="xml-punct">${escHtml(am[2])}</span>` +
      `<span class="xml-attr-quote">${escHtml(am[3])}</span>` +
      `<span class="xml-attr-val">${escHtml(am[4])}</span>` +
      `<span class="xml-attr-quote">${escHtml(am[5])}</span>`;

  return sp + `<span class="xml-text">${escHtml(t)}</span>`;
}

function syntaxHighlightXml(xmlStr) {
  return xmlStr.split('\n').map(hlXmlLine).join('\n');
}

function copyXmlToClipboard(seq, btn) {
  const ev = state.events.find(e => e.seq === seq);
  if (!ev || !ev.rawXml) return;
  const pretty = prettyPrintXml(ev.rawXml);
  navigator.clipboard.writeText(pretty).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 1600);
  }).catch(() => {
    const code = btn.closest('.xml-viewer')?.querySelector('.xml-viewer-code');
    if (code) {
      const r = document.createRange(); r.selectNodeContents(code);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    }
  });
}

// ═══════════════════════════════════════════════════════
//  EVENT DETAIL
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
//  SMART DETAIL RENDERERS
// ═══════════════════════════════════════════════════════
function renderSmartDetail(ev) {
  if (!state.smartViewEnabled) return null;
  const et = (ev.eventType || '').toLowerCase();
  
  if (et.includes('db ') || et.includes('database') || et.includes('sql') || et.includes('dbt')) {
    return renderDbDetail(ev);
  }
  if (et.includes('alert')) {
    return renderAlertDetail(ev);
  }
  if (et.includes('connect')) {
    return renderConnectDetail(ev);
  }
  return null;
}

function renderDbDetail(ev) {
  const sql = ev.children?.DBTSQL || ev.message || '';
  if (!sql) return null;
  
  let html = `<div class="sd-section">
    <div class="sd-title">SQL Query</div>
    <div class="sd-content sd-sql">${formatSql(sql)}</div>
  </div>`;

  // Show other DBT metrics if available
  const metrics = [];
  if (ev.children?.DBTROW) metrics.push({ label: 'Rows', val: ev.children.DBTROW });
  if (ev.children?.DBTCPP) metrics.push({ label: 'Pool', val: ev.children.DBTCPP });
  if (ev.children?.DBTERR) metrics.push({ label: 'DB Error', val: ev.children.DBTERR, class: 'danger' });
  
  if (metrics.length > 0) {
    html += `<div class="alert-box" style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;">
      <div class="alert-metrics">`;
    metrics.forEach(m => {
      html += `<div class="am-item">
        <span class="am-label">${escHtml(m.label)}</span>
        <span class="am-value ${m.class || ''}">${escHtml(m.val)}</span>
      </div>`;
    });
    html += `</div></div>`;
  }

  return html;
}

function formatSql(sql) {
  const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'UPDATE', 'SET', 'INSERT INTO', 'VALUES', 'DELETE', 'IN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'BETWEEN', 'LIKE', 'NULL', 'IS', 'NOT', 'UNION', 'ALL'];
  let formatted = escHtml(sql);
  
  // Simple keyword highlighting
  keywords.forEach(kw => {
    const re = new RegExp(`\\b${kw}\\b`, 'gi');
    formatted = formatted.replace(re, m => `<span class="keyword">${m.toUpperCase()}</span>`);
  });
  
  return formatted;
}

function renderAlertDetail(ev) {
  const msg = ev.message || '';
  // Basic alert parsing: looking for "threshold" and "value"
  // Example: "Threshold: 500 ms, Actual: 1200 ms"
  let html = `<div class="alert-box">
    <div class="sd-title">Performance Alert</div>
    <div class="sd-content">${escHtml(msg)}</div>`;
    
  const thresholdMatch = msg.match(/threshold[:\s]+(\d+)/i);
  const actualMatch = msg.match(/(?:actual|value)[:\s]+(\d+)/i);
  
  if (thresholdMatch || actualMatch) {
    html += `<div class="alert-metrics">`;
    if (thresholdMatch) {
      html += `<div class="am-item"><span class="am-label">Threshold</span><span class="am-value ok">${thresholdMatch[1]}ms</span></div>`;
    }
    if (actualMatch) {
      html += `<div class="am-item"><span class="am-label">Actual</span><span class="am-value">${actualMatch[1]}ms</span></div>`;
    }
    html += `</div>`;
  }
  
  html += `</div>`;
  return html;
}

function renderConnectDetail(ev) {
  const msg = ev.children?.ConnectRequest || ev.children?.ConnectResponse || ev.message || '';
  if (!msg.startsWith('{') && !msg.startsWith('<')) return null;
  
  if (msg.startsWith('{')) {
    try {
      const obj = JSON.parse(msg);
      return `<div class="sd-section">
        <div class="sd-title">JSON Payload</div>
        <div class="sd-content mono">${escHtml(JSON.stringify(obj, null, 2))}</div>
      </div>`;
    } catch(e) {}
  }
  
  if (msg.startsWith('<')) {
    try {
      const pretty = prettyPrintXml(msg);
      return `<div class="sd-section">
        <div class="sd-title">XML Payload</div>
        <div class="sd-content mono">${escHtml(pretty)}</div>
      </div>`;
    } catch(e) {}
  }
  
  return null;
}

function showEventDetail(seq) {
  const ev = state.events.find(e => e.seq === seq);
  if (!ev) return;

  // Handle Comparison mode
  if (state.compareSelection.first && state.compareSelection.first.seq !== seq) {
    pickSecondForCompare(seq);
    return;
  }

  state.selectedEventSeq = seq;

  const body = document.getElementById('detail-body');
  const title = document.getElementById('detail-title');

  title.textContent = `Event #${seq} — ${ev.eventType || ''}`;

  const fields = [
    ['Sequence', ev.seq],
    ['Event Type', ev.eventType],
    ['Date/Time', formatDateTime(ev.dateTime)],
    ['Step Status', ev.stepStatus || '(none)'],
    ['Elapsed', formatElapsed(ev.elapsed) || '—'],
    ['Key Name', ev.keyname],
    ['Rule Name', ev.name],
    ['Step', ev.step],
    ['Step Method', ev.stepMethod],
    ['Step Page', ev.stepPage],
    ['Interaction', ev.interaction],
    ['Thread', ev.threadName],
    ['RS Name', ev.rsname],
    ['RS Version', ev.rsvers],
    ['WorkPool', ev.workPool],
    ['Message', ev.message],
  ];

  let html = '';
  for (const [label, val] of fields) {
    if (!val && val !== 0) continue;
    html += `<div class="detail-field">
      <div class="df-label">${escHtml(label)}</div>
      <div class="df-value">${escHtml(String(val))}</div>
    </div>`;
  }

  if (ev.rawXml) {
    const prettyXml  = prettyPrintXml(ev.rawXml);
    const highlighted = syntaxHighlightXml(prettyXml);
    html += `<div class="detail-field">
      <div class="xml-viewer">
        <div class="xml-viewer-toolbar">
          <span class="xml-viewer-label">Raw XML</span>
          <button class="xml-copy-btn" onclick="copyXmlToClipboard(${ev.seq}, this)">⎘ Copy</button>
        </div>
        <div class="xml-viewer-code">${highlighted}</div>
      </div>
    </div>`;
  }

  body.innerHTML = html;

  // SMART DETAIL
  const sdHtml = renderSmartDetail(ev);
  if (sdHtml) {
    const sdWrap = document.createElement('div');
    sdWrap.className = 'smart-insight-card';
    sdWrap.innerHTML = `
      <div class="smart-badge">✨ SMART INSIGHT</div>
      ${sdHtml}
    `;
    body.insertBefore(sdWrap, body.firstChild);
  }

  const bmBtn = document.getElementById('detail-bm-btn');
  if (bmBtn) {
    const isBm = state.bookmarks.has(seq);
    bmBtn.textContent = isBm ? '★' : '☆';
    bmBtn.classList.toggle('active', isBm);
    bmBtn.title = isBm ? 'Remove bookmark' : 'Add bookmark';
  }
}

function closeDetail() {
  state.selectedEventSeq = -1;
  document.getElementById('detail-title').textContent = 'Event Detail';
  document.getElementById('detail-body').innerHTML =
    '<div class="detail-placeholder"><div class="dp-icon">🔍</div><p>Click any event to inspect<br>its fields and XML</p></div>';
}

// ═══════════════════════════════════════════════════════
//  SPLIT PANE RESIZE
// ═══════════════════════════════════════════════════════
const DETAIL_WIDTH_KEY = 'pega-detail-width';

function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const panel  = document.getElementById('detail-panel');

  const saved = parseInt(localStorage.getItem(DETAIL_WIDTH_KEY), 10);
  if (saved >= 200) panel.style.width = saved + 'px';

  let startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const dx = startX - e.clientX;
      const maxW = Math.floor(window.innerWidth * 0.75);
      const newW = Math.min(maxW, Math.max(200, startW + dx));
      panel.style.width = newW + 'px';
      if (state.currentTab === 'flame') drawFlamegraph();
    }

    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(DETAIL_WIDTH_KEY, String(panel.offsetWidth));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (state.currentTab === 'flame') setTimeout(drawFlamegraph, 50);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ═══════════════════════════════════════════════════════
//  BOOKMARKS
// ═══════════════════════════════════════════════════════
const BM_KEY_PREFIX = 'pega-bm-';

function bmStorageKey() {
  return BM_KEY_PREFIX + (state.currentFileName || '_default');
}

function loadBookmarks(filename) {
  state.currentFileName = filename || '';
  state.bookmarks = new Map();
  try {
    const raw = localStorage.getItem(BM_KEY_PREFIX + state.currentFileName);
    if (raw) {
      const arr = JSON.parse(raw);
      for (const item of arr) state.bookmarks.set(item.seq, item);
    }
  } catch(e) { state.bookmarks = new Map(); }
  updateBookmarkBadge();
}

function saveBookmarks() {
  try {
    localStorage.setItem(bmStorageKey(), JSON.stringify([...state.bookmarks.values()]));
  } catch(e) {}
}

function toggleBookmark(seq, e) {
  if (e) e.stopPropagation();
  if (!seq || seq < 0) return;
  const ev = state.events.find(ev => ev.seq === seq);
  if (!ev) return;

  if (state.bookmarks.has(seq)) {
    state.bookmarks.delete(seq);
  } else {
    state.bookmarks.set(seq, { seq, addedAt: Date.now() });
  }
  saveBookmarks();
  updateBookmarkBadge();

  if (state.selectedEventSeq === seq) {
    const bmBtn = document.getElementById('detail-bm-btn');
    if (bmBtn) {
      const isBm = state.bookmarks.has(seq);
      bmBtn.textContent = isBm ? '★' : '☆';
      bmBtn.classList.toggle('active', isBm);
      bmBtn.title = isBm ? 'Remove bookmark' : 'Add bookmark';
    }
  }

  if (state.currentTab === 'table')     renderVisibleRows();
  if (state.currentTab === 'tree')      renderTree();
  if (state.currentTab === 'bookmarks') renderBookmarksPanel();
}

function clearAllBookmarks() {
  state.bookmarks.clear();
  saveBookmarks();
  updateBookmarkBadge();
  renderBookmarksPanel();
  if (state.currentTab === 'table') renderVisibleRows();
  if (state.currentTab === 'tree')  renderTree();
  const bmBtn = document.getElementById('detail-bm-btn');
  if (bmBtn) { bmBtn.textContent = '☆'; bmBtn.classList.remove('active'); bmBtn.title = 'Add bookmark'; }
}

function updateBookmarkBadge() {
  const tab = document.getElementById('bookmarks-tab');
  if (!tab) return;
  const count = state.bookmarks.size;
  let badge = tab.querySelector('.tab-badge');
  if (count > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge warn'; tab.appendChild(badge); }
    badge.textContent = count;
  } else {
    if (badge) badge.remove();
  }
  const countEl = document.getElementById('bm-count');
  if (countEl) countEl.textContent = `${count} bookmark${count !== 1 ? 's' : ''}`;
}

function renderBookmarksPanel() {
  const scroller = document.getElementById('bm-scroller');
  if (!scroller) return;
  updateBookmarkBadge();

  if (state.bookmarks.size === 0) {
    scroller.innerHTML = '<div class="bm-empty">No bookmarks yet.<br>Click the ★ star on any event<br>in the Table or Tree view to flag it.</div>';
    return;
  }

  const bms = [...state.bookmarks.values()].sort((a, b) => a.seq - b.seq);
  let html = '';
  for (const bm of bms) {
    const ev = state.events.find(e => e.seq === bm.seq);
    if (!ev) continue;
    const etClass = getEventTypeClass(ev.eventType);
    const displayName = ev.keyname || ev.name || '';
    const st = ev.stepStatus;
    const statusHtml = st
      ? `<span class="bm-status ${st === 'Fail' ? 'fail' : 'warn'}">${escHtml(st)}</span>`
      : '';
    html += `<div class="bm-row" onclick="showEventDetail(${ev.seq})">
      <button class="bm-star active" onclick="toggleBookmark(${ev.seq}, event)" title="Remove bookmark">★</button>
      <span class="bm-seq">#${ev.seq}</span>
      <span class="bm-type ${etClass}">${escHtml(ev.eventType || '')}</span>
      <span class="bm-name" title="${escHtml(displayName)}">${escHtml(displayName.slice(0, 70))}</span>
      ${statusHtml}
      <span class="bm-elapsed">${formatElapsed(ev.elapsed)}</span>
    </div>`;
  }
  scroller.innerHTML = html;
}

function toggleSmartView() {
  state.smartViewEnabled = !state.smartViewEnabled;
  localStorage.setItem(SMART_VIEW_KEY, state.smartViewEnabled);
  const btn = document.getElementById('smart-toggle-btn');
  if (btn) btn.classList.toggle('active', state.smartViewEnabled);
  if (state.selectedEventSeq !== -1) showEventDetail(state.selectedEventSeq);
}

// ═══════════════════════════════════════════════════════
//  TAB SWITCHING
// ═══════════════════════════════════════════════════════
function switchTab(name) {
  state.currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

  const panelId = 'panel-' + (name === 'flame' ? 'flame' : name);
  document.getElementById(panelId)?.classList.add('active');

  if (name === 'flame') setTimeout(drawFlamegraph, 50);
  if (name === 'tree') renderTree();
  if (name === 'hotspots') renderHotspots();
  if (name === 'bookmarks') renderBookmarksPanel();
}

// ═══════════════════════════════════════════════════════
//  FILE HANDLING
// ═══════════════════════════════════════════════════════
let currentParser = null;

function loadFile(file) {
  if (currentParser) currentParser.cancel();

  state.events = [];
  state.filteredEvents = [];
  state.treeRoots = [];
  state.flatTree = [];
  state.stats = null;
  state.treeExpanded = new Set();
  state.flameNodes = [];
  state.flameZoom = { start: 0, end: 1 };

  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('filename').textContent = file.name + ` (${(file.size/1024/1024).toFixed(1)} MB)`;
  document.getElementById('debug-export-btn').disabled = true;
  debugCollector.reset();
  sanitizer.reset();
  loadBookmarks(file.name);

  const progressArea = document.getElementById('progress-area');
  progressArea.classList.remove('hidden');
  progressArea.classList.add('visible');
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-text').textContent = 'Starting...';

  const t0 = Date.now();

  currentParser = new PegaStreamParser(
    file,
    (ev) => { state.events.push(ev); },
    (progress, count) => {
      document.getElementById('progress-bar').style.width = (progress * 100).toFixed(1) + '%';
      document.getElementById('progress-text').textContent =
        `Parsing… ${count.toLocaleString()} events | ${(progress*100).toFixed(1)}% | ${((file.size*progress)/1024/1024).toFixed(0)} MB`;
    },
    (count, err) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      document.getElementById('progress-text').textContent =
        `✓ Parsed ${count.toLocaleString()} events in ${elapsed}s${err ? ' — ' + err : ''}`;
      setTimeout(() => {
        progressArea.classList.remove('visible');
        progressArea.classList.add('hidden');
      }, 2500);

      state.stats = buildStats(state.events);
      state.filteredEvents = [...state.events];
      state.treeRoots = buildTree(state.events);
      propagateOwnDuration(state.treeRoots, state.events);
      state.stats = buildStats(state.events); // rebuild after propagation
      state.flameNodes = buildFlameNodes(state.treeRoots);
      state.hotspotsData = buildHotspots(state.events);
      sortHotspots('selfTime');

      updateTabBadges();
      populateTypeFilter();
      renderTableView();
      renderSummary();
      renderTree();

      document.getElementById('debug-export-btn').disabled = false;
    }
  );

  currentParser.start();
}

function updateTabBadges() {
  const s = state.stats;
  document.querySelectorAll('.tab').forEach(t => {
    if (t.id === 'bookmarks-tab') return;
    const old = t.querySelector('.tab-badge');
    if (old) old.remove();
  });

  const sumTab = document.querySelector('.tab[data-tab="summary"]');
  const problemCount = (s.fails ? s.fails.length : 0) + (s.exceptions ? s.exceptions.length : 0);
  if (problemCount > 0) {
    const b = document.createElement('span');
    b.className = 'tab-badge'; // Red by default
    b.textContent = problemCount;
    sumTab.appendChild(b);
  }

  // Table/Tree Filter Badges
  if (state.activeHotspotFilter || gsearch.active) {
    const tableTab = document.querySelector('.tab[data-tab="table"]');
    const treeTab = document.querySelector('.tab[data-tab="tree"]');
    
    // For table, use filteredEvents count
    const tb = document.createElement('span');
    tb.className = 'tab-badge';
    tb.textContent = state.filteredEvents.length;
    tableTab.appendChild(tb);

    // For tree, we'll use the flatTree count after it's been rendered
    const trb = document.createElement('span');
    trb.className = 'tab-badge';
    trb.textContent = state.flatTree.length;
    treeTab.appendChild(trb);
  }
}

// ═══════════════════════════════════════════════════════
//  DRAG & DROP
// ═══════════════════════════════════════════════════════
function initDragDrop() {
  const dz = document.getElementById('dropzone');
  document.body.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  document.body.addEventListener('dragleave', e => { if (!e.relatedTarget) dz.classList.remove('drag-over'); });
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  document.getElementById('file-input').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });
}

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ═══════════════════════════════════════════════════════
//  SANITIZER
// ═══════════════════════════════════════════════════════
const sanitizer = {
  _map: new Map(),
  _counters: {},

  reset() { this._map.clear(); this._counters = {}; },

  _token(category, realValue) {
    const key = category + ':' + realValue;
    if (this._map.has(key)) return this._map.get(key);
    const n = (this._counters[category] = (this._counters[category] || 0) + 1);
    let token;
    switch (category) {
      case 'email':    token = `user${n}@example-redacted.com`; break;
      case 'ip4':      token = `10.REDACTED.REDACTED.${n}`; break;
      case 'ip6':      token = `[ipv6-redacted-${n}]`; break;
      case 'host':     token = `HOSTNAME-${n}.redacted.internal`; break;
      case 'url':      token = `https://REDACTED-HOST-${n}/path`; break;
      case 'operator': token = `OPERATOR-${n}`; break;
      case 'casekey':  token = `CASE-REDACTED-${n}`; break;
      case 'ssn':      token = `SSN-REDACTED-${n}`; break;
      case 'phone':    token = `PHONE-REDACTED-${n}`; break;
      case 'jwt':      token = `[JWT-REDACTED-${n}]`; break;
      case 'b64long':  token = `[BASE64-REDACTED-${n}]`; break;
      default:         token = `REDACTED-${category.toUpperCase()}-${n}`;
    }
    this._map.set(key, token);
    return token;
  },

  clean(text) {
    if (!text) return text;
    let out = text;
    const rep = (cat, real) => this._token(cat, real);

    out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, m => rep('jwt', m));
    out = out.replace(/\b[A-Za-z0-9+\/]{40,}={0,2}\b/g, m => rep('b64long', m));
    out = out.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, m => rep('email', m.toLowerCase()));
    out = out.replace(/https?:\/\/[^\s"'<>\]},]+/g, m => rep('url', m));
    out = out.replace(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, m => rep('ip4', m));
    out = out.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, m => rep('ip6', m));
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, m => rep('ssn', m));
    out = out.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g, m => rep('phone', m));
    out = out.replace(/\b[A-Za-z]{2,}[.\-\\][A-Za-z]{2,}(?:[.\-\\][A-Za-z0-9]{1,})*\b/g, m => {
      if (/^\d/.test(m)) return m;
      if (/^(Step|Flow|Activity|Decision|Data|DB|Connect|Service|Validate|Exception)/i.test(m)) return m;
      return rep('operator', m);
    });
    out = out.replace(/\b[A-Z][A-Z0-9]{1,10}-[A-Z][A-Z0-9]{1,10}-[A-Z][A-Z0-9]{1,20}-\d{1,10}\b/g, m => rep('casekey', m));
    out = out.replace(/\b(?:[a-z][a-z0-9\-]{2,}\.){1,4}(?:internal|corp|local|intranet|company|org|net|co|io|com)\b/gi, m => rep('host', m.toLowerCase()));

    return { text: out, hits: 0 };
  },

  cleanXmlAttrs(xmlStr) {
    return xmlStr.replace(/="([^"]*)"/g, (full, val) => {
      const { text } = this.clean(val);
      return `="${text}"`;
    });
  },

  cleanXml(xmlStr) {
    let out = xmlStr.replace(/="([^"]*)"/g, (full, val) => {
      const { text } = this.clean(val);
      return `="${text}"`;
    });
    out = out.replace(/>([^<]+)</g, (full, content) => {
      const { text } = this.clean(content);
      return `>${text}<`;
    });
    return out;
  },

  summary() {
    const lines = ['  SANITIZATION APPLIED — real values replaced with stable tokens:'];
    const cats = {};
    for (const [key] of this._map) {
      const cat = key.split(':')[0];
      cats[cat] = (cats[cat] || 0) + 1;
    }
    if (Object.keys(cats).length === 0) {
      lines.push('    (no sensitive patterns detected)');
    } else {
      for (const [cat, count] of Object.entries(cats).sort()) {
        lines.push(`    ${count.toString().padStart(4)}  ${cat} value(s) tokenised`);
      }
    }
    return lines.join('\n');
  }
};

// ═══════════════════════════════════════════════════════
//  DEBUG COLLECTOR + SNAPSHOT EXPORT
// ═══════════════════════════════════════════════════════
const debugCollector = {
  childTagsByEventType: {},
  allAttrNames: new Set(),
  truncatedSeqs: [],
  anomalies: [],
  eventTypeSamples: {},
  cdataByEventType: {},
  largestEvents: [],

  reset() {
    this.childTagsByEventType = {};
    this.allAttrNames = new Set();
    this.truncatedSeqs = [];
    this.anomalies = [];
    this.eventTypeSamples = {};
    this.cdataByEventType = {};
    this.largestEvents = [];
  },

  ingest(ev, rawXml) {
    const et = ev.eventType || '(unknown)';

    const attrRe = /(\w+)="/g;
    const openEnd = rawXml.indexOf('>');
    const openTag = openEnd > 0 ? rawXml.slice(0, openEnd) : rawXml;
    let m;
    while ((m = attrRe.exec(openTag)) !== null) this.allAttrNames.add(m[1]);

    const tagRe = /<(\w[\w:-]*)[\s>\/]/g;
    const afterOpen = rawXml.slice(openEnd + 1);
    const tags = new Set();
    while ((m = tagRe.exec(afterOpen)) !== null) {
      const tag = m[1];
      if (tag !== 'TraceEvent') tags.add(tag);
    }
    if (!this.childTagsByEventType[et]) this.childTagsByEventType[et] = new Set();
    for (const t of tags) this.childTagsByEventType[et].add(t);

    const hasCdata = rawXml.includes('<![CDATA[');
    if (hasCdata) this.cdataByEventType[et] = (this.cdataByEventType[et] || 0) + 1;

    if (!this.eventTypeSamples[et]) {
      let sample = rawXml
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '<![CDATA[ ...content stripped... ]]>')
        .slice(0, 1200);
      if (rawXml.length > 1200) sample += '\n    ... [sample truncated]';
      this.eventTypeSamples[et] = sample;
    }

    if (ev.rawXml && ev.rawXml.endsWith('... [truncated]')) this.truncatedSeqs.push(ev.seq);
    if (!ev.seq || ev.seq === 0) this.anomalies.push({ seq: ev.seq, reason: 'seq=0 or missing', et });
    if (!ev.eventType) this.anomalies.push({ seq: ev.seq, reason: 'missing eventType', et });

    const size = rawXml.length;
    this.largestEvents.push({ seq: ev.seq, et, size });
    this.largestEvents.sort((a,b) => b.size - a.size);
    if (this.largestEvents.length > 5) this.largestEvents.length = 5;
  },

  buildSchemaReport() {
    const lines = [];
    lines.push('  ┌─────────────────────────────────────────────────────┐');
    lines.push('  │  SCHEMA FINGERPRINT — what this file actually has    │');
    lines.push('  └─────────────────────────────────────────────────────┘');
    lines.push('');
    lines.push('  ALL ATTRIBUTE NAMES SEEN ON <TraceEvent> ELEMENTS:');
    lines.push('  ' + [...this.allAttrNames].sort().join(', '));
    lines.push('');
    lines.push('  CHILD ELEMENTS BY EVENT TYPE:');
    lines.push('  (★ = has CDATA content that parser currently ignores)');
    lines.push('');
    for (const [et, tags] of Object.entries(this.childTagsByEventType).sort()) {
      const cdataStar = this.cdataByEventType[et] ? ` ★ CDATA in ${this.cdataByEventType[et]} events` : '';
      lines.push(`  ${et}${cdataStar}`);
      lines.push(`    tags: ${[...tags].sort().join(', ')}`);
    }
    lines.push('');
    if (this.truncatedSeqs.length) {
      lines.push(`  TRUNCATED EVENTS (rawXml > 8000 chars, ${this.truncatedSeqs.length} total):`);
      lines.push(`  seqs: ${this.truncatedSeqs.slice(0,20).join(', ')}${this.truncatedSeqs.length > 20 ? '...' : ''}`);
      lines.push('');
    }
    if (this.largestEvents.length) {
      lines.push('  TOP 5 LARGEST EVENTS (bytes of raw XML):');
      for (const e of this.largestEvents) lines.push(`    seq ${e.seq}  ${(e.size/1024).toFixed(1)} KB  ${e.et}`);
      lines.push('');
    }
    if (this.anomalies.length) {
      lines.push(`  PARSER ANOMALIES (${this.anomalies.length}):`);
      for (const a of this.anomalies.slice(0,20)) lines.push(`    seq ${a.seq}: ${a.reason} | eventType="${a.et}"`);
      lines.push('');
    }
    return lines.join('\n');
  },

  buildSamplesSection() {
    const lines = [];
    lines.push('  ┌─────────────────────────────────────────────────────┐');
    lines.push('  │  SCHEMA SAMPLES PER EVENT TYPE                       │');
    lines.push('  │  (attribute values + text content removed)           │');
    lines.push('  └─────────────────────────────────────────────────────┘');
    lines.push('');
    for (const [et, sample] of Object.entries(this.eventTypeSamples).sort()) {
      lines.push(`  ── ${et} ──`);
      let scrubbed = sample
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '<![CDATA[...stripped...]]>')
        .replace(/="[^"]*"/g, '="..."')
        .replace(/>([^<]+)</g, '>[...text stripped...]<');
      lines.push('  ' + scrubbed.replace(/\n/g, '\n  '));
      lines.push('');
    }
    return lines.join('\n');
  }
};

function exportDebugSnapshot() {
  if (!state.events.length) return;

  const s = state.stats;
  const total = state.events.length;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const lines = [];
  lines.push('PEGA TRACER VIEWER — DEBUG SNAPSHOT');
  lines.push(`Generated : ${new Date().toISOString()}`);
  lines.push(`Source    : (filename redacted)`);
  lines.push(`Total events in file: ${total.toLocaleString()}`);
  lines.push('');
  lines.push('=== STATISTICS ===');
  lines.push(`Failures         : ${s.fails.length}`);
  lines.push(`Warnings         : ${s.warnings.length}`);
  lines.push(`Exceptions       : ${s.exceptions.length}`);
  lines.push(`Thread count     : ${s.threads.size}`);
  lines.push(`Interaction count: ${s.interactions.size}`);
  lines.push(`Seq range        : ${s.minSeq} – ${s.maxSeq}`);
  lines.push(`Date range       : ${formatDateTime(s.dateRange.start)} – ${formatDateTime(s.dateRange.end)}`);
  lines.push('');
  lines.push('EVENT TYPE COUNTS:');
  for (const [et, cnt] of Object.entries(s.eventTypeCounts).sort((a,b)=>b[1]-a[1])) {
    const pct = (cnt / total * 100).toFixed(1);
    lines.push(`  ${cnt.toString().padStart(7)}  (${pct.padStart(5)}%)  ${et}`);
  }
  lines.push('');
  lines.push(debugCollector.buildSchemaReport());
  lines.push(debugCollector.buildSamplesSection());

  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const actualMB = (blob.size / 1024 / 1024).toFixed(2);

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pega-debug-snapshot-SANITIZED-${ts}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);

  const btn = document.getElementById('debug-export-btn');
  const orig = btn.textContent;
  btn.textContent = `✓ ${actualMB} MB saved`;
  setTimeout(() => { btn.textContent = orig; }, 3000);
}

// ═══════════════════════════════════════════════════════
//  GLOBAL SEARCH
// ═══════════════════════════════════════════════════════
const gsearch = {
  active: false,
  useRegex: false,
  term: '',
  results: [],
  matchedSeqs: new Set(),
  matchedEventsArr: [],
  searchId: 0,
  debounceTimer: null,
};

const SEARCH_FIELDS = [
  ['eventType',  e => e.eventType],
  ['keyname',    e => e.keyname],
  ['name',       e => e.name],
  ['stepStatus', e => e.stepStatus],
  ['stepMethod', e => e.stepMethod],
  ['stepPage',   e => e.stepPage],
  ['step',       e => e.step],
  ['message',    e => e.message],
  ['threadName', e => e.threadName],
  ['interaction',e => e.interaction],
  ['workPool',   e => e.workPool],
  ['inskey',     e => e.inskey],
  ['rsname',     e => e.rsname],
  ['dateTime',   e => e.dateTime],
  ['rawXml',     e => e.rawXml],
];

function onGlobalSearchInput() {
  const val = document.getElementById('gsearch-input').value;
  clearTimeout(gsearch.debounceTimer);
  gsearch.debounceTimer = setTimeout(() => runGlobalSearch(val), 180);
}

function toggleSearchRegex() {
  gsearch.useRegex = !gsearch.useRegex;
  document.getElementById('gsearch-regex').classList.toggle('active', gsearch.useRegex);
  const val = document.getElementById('gsearch-input').value;
  if (val) runGlobalSearch(val);
}

function clearGlobalSearch() {
  document.getElementById('gsearch-input').value = '';
  document.getElementById('gsearch-input').classList.remove('invalid');
  document.getElementById('gsearch-count').textContent = '';
  gsearch.active = false;
  gsearch.results = [];
  gsearch.matchedSeqs = new Set();
  gsearch.matchedEventsArr = [];
  gsearch.searchId++;
  document.getElementById('search-tab').style.display = 'none';
  if (state.currentTab === 'search') switchTab('summary');
  updateSearchBanners();
  filterTable();
  renderTree();
}

function runGlobalSearch(term) {
  gsearch.term = term;
  const myId = ++gsearch.searchId;

  if (!term.trim() || !state.events.length) { clearGlobalSearch(); return; }

  let re = null;
  if (gsearch.useRegex) {
    try {
      re = new RegExp(term, 'i');
      document.getElementById('gsearch-input').classList.remove('invalid');
    } catch(e) {
      document.getElementById('gsearch-input').classList.add('invalid');
      document.getElementById('gsearch-count').textContent = 'invalid regex';
      return;
    }
  } else {
    document.getElementById('gsearch-input').classList.remove('invalid');
  }

  const lterm = term.toLowerCase();
  const matchFn = gsearch.useRegex ? (s) => re.test(s) : (s) => s.toLowerCase().includes(lterm);

  document.getElementById('search-tab').style.display = '';
  switchTab('search');
  document.getElementById('sr-count').textContent = 'Searching…';
  document.getElementById('sr-regex-label').textContent = gsearch.useRegex ? '⚡ regex mode' : '';

  gsearch.results = [];
  const events = state.events;
  const total = events.length;
  const CHUNK = 3000;
  let idx = 0;

  function processChunk() {
    if (myId !== gsearch.searchId) return;
    const end = Math.min(idx + CHUNK, total);
    for (let i = idx; i < end; i++) {
      const ev = events[i];
      for (const [field, getter] of SEARCH_FIELDS) {
        const val = getter(ev);
        if (!val) continue;
        if (matchFn(val)) {
          const snippet = makeSnippet(val, term, gsearch.useRegex ? re : null, lterm);
          gsearch.results.push({ ev, matchField: field, snippet });
          break;
        }
      }
    }
    idx = end;

    const pct = Math.round(idx / total * 100);
    document.getElementById('sr-count').textContent = `${gsearch.results.length.toLocaleString()} matches (${pct}%)…`;

    if (idx < total) {
      setTimeout(processChunk, 0);
    } else {
      gsearch.active = true;
      gsearch.matchedSeqs = new Set(gsearch.results.map(r => r.ev.seq));
      gsearch.matchedEventsArr = gsearch.results.map(r => r.ev);
      document.getElementById('sr-count').textContent =
        `${gsearch.results.length.toLocaleString()} match${gsearch.results.length !== 1 ? 'es' : ''} in ${total.toLocaleString()} events`;
      document.getElementById('gsearch-count').textContent =
        gsearch.results.length ? `${gsearch.results.length.toLocaleString()} hits` : 'no hits';
      updateSearchBanners();
      filterTable();
      renderTree();
      renderSearchResults();
    }
  }

  setTimeout(processChunk, 0);
}

function makeSnippet(text, term, re, lterm) {
  if (!text) return '';
  const str = String(text);
  let idx = -1;
  if (re) { const m = re.exec(str); if (m) idx = m.index; }
  else idx = str.toLowerCase().indexOf(lterm);
  if (idx === -1) return str.slice(0, 100);
  const start = Math.max(0, idx - 40);
  const end = Math.min(str.length, idx + 100);
  return (start > 0 ? '…' : '') + str.slice(start, end) + (end < str.length ? '…' : '');
}

function highlightSnippet(snippet, term, re, lterm) {
  const safe = escHtml(snippet);
  if (!term) return safe;
  try {
    const flagRe = re ? new RegExp(re.source, 'gi') : new RegExp(escRegex(term), 'gi');
    return safe.replace(flagRe, m => `<mark class="sh">${escHtml(m)}</mark>`);
  } catch(e) { return safe; }
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SR_ROW_H = 52;

function renderSearchResults() {
  const scroller = document.getElementById('sr-scroller');
  const results = gsearch.results;
  if (!results.length) { scroller.innerHTML = '<div class="empty-msg">No matches found.</div>'; return; }

  const totalH = results.length * SR_ROW_H;
  scroller.innerHTML = `<div id="sr-inner" style="position:relative;height:${totalH}px;"></div>`;
  const inner = document.getElementById('sr-inner');

  function renderVisible() {
    const scrollTop = scroller.scrollTop;
    const clientH = scroller.clientHeight;
    const startI = Math.max(0, Math.floor(scrollTop / SR_ROW_H) - 3);
    const endI = Math.min(results.length, Math.ceil((scrollTop + clientH) / SR_ROW_H) + 3);

    let html = '';
    const re = gsearch.useRegex ? (() => { try { return new RegExp(gsearch.term, 'i'); } catch(e) { return null; } })() : null;
    const lterm = gsearch.term.toLowerCase();

    for (let i = startI; i < endI; i++) {
      const { ev, matchField, snippet } = results[i];
      const y = i * SR_ROW_H;
      const etClass = getEventTypeClass(ev.eventType);
      const st = ev.stepStatus;
      const statusHtml = st ? `<span class="sr-status ${st.toLowerCase() === 'fail' ? 'fail' : 'warn'}">${escHtml(st)}</span>` : '';
      const displayName = escHtml((ev.keyname || ev.name || '').slice(0, 80));
      const snippetHtml = highlightSnippet(snippet, gsearch.term, re, lterm);
      const fieldLabel = matchField === 'rawXml' ? '<em>raw xml</em>' : `<em>${matchField}</em>`;

      html += `<div class="sr-row" style="position:absolute;top:${y}px;left:0;right:0;height:${SR_ROW_H}px;"
          onclick="showEventDetail(${ev.seq})">
        <div class="sr-top">
          <span class="sr-seq">#${ev.seq}</span>
          <span class="sr-type ${etClass}">${escHtml(ev.eventType || '')}</span>
          <span class="sr-name">${displayName}</span>
          ${statusHtml}
          <span class="sr-field">in ${fieldLabel}</span>
          <span class="sr-elapsed">${formatElapsed(ev.elapsed)}</span>
        </div>
        <div class="sr-snippet">${snippetHtml}</div>
      </div>`;
    }
    inner.innerHTML = html;
  }

  scroller.addEventListener('scroll', renderVisible, { passive: true });
  renderVisible();
}

function updateSearchBanners() {
  const active = gsearch.active;
  const term = gsearch.term;
  const count = gsearch.matchedEventsArr.length;
  const countTxt = `— ${count.toLocaleString()} event${count !== 1 ? 's' : ''}`;

  ['tree', 'table'].forEach(view => {
    const banner = document.getElementById(`${view}-gsearch-banner`);
    const termEl = document.getElementById(`${view}-gsb-term`);
    const countEl = document.getElementById(`${view}-gsb-count`);
    if (!banner) return;
    banner.classList.toggle('visible', active);
    if (termEl) termEl.textContent = term;
    if (countEl) countEl.textContent = active ? countTxt : '';
  });
}

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
window.addEventListener('load', () => {
  initDragDrop();
  initFlameEvents();
  initResizeHandle();
  loadSettings();
  renderSummary();

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      document.getElementById('gsearch-input').focus();
      document.getElementById('gsearch-input').select();
    }
  });

  window.addEventListener('resize', () => {
    if (state.currentTab === 'flame') drawFlamegraph();
  });
});

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--bg3);color:var(--text);padding:8px 16px;border-radius:20px;border:1px solid var(--blue);font-size:11px;z-index:3000;box-shadow:0 10px 30px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.3s;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
