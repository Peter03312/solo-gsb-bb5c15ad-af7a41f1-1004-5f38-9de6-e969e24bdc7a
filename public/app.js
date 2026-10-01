'use strict';
/* 舞台监督提示单系统 —— 前端单页应用（原生 JS，hash 路由） */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const connEl = document.getElementById('conn');

const TYPE_TEXT = { light: '灯光', sound: '音效', set: '布景', other: '其他' };
const STATUS_TEXT = { pending: '待执行', fired: '已触发', skipped: '已跳过', blocked: '受阻' };
const REQUEST_STATUS_TEXT = { pending: '待复核', confirmed: '已确认', cancelled: '已撤销', rejected: '已驳回' };

let toastTimer = null;
let pollTimer = null;

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString('zh-CN', { hour12: false });
}

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4200);
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    connEl.textContent = '连接失败';
    throw new Error('无法连接服务器');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  connEl.textContent = '';
  return data;
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function getOperator() {
  return (document.getElementById('operator-input') || {}).value ||
    localStorage.getItem('operator') || '';
}

/* ---------- 路由 ---------- */

function route() {
  stopPolling();
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').filter(Boolean);
  if (parts.length === 0) return renderShows();
  if (parts[0] === 'shows' && parts[1]) return renderShow(parts[1]);
  if (parts[0] === 'versions' && parts[1]) return renderVersion(parts[1]);
  if (parts[0] === 'performances' && parts[1]) return renderPerformance(parts[1]);
  renderShows();
}
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

/* ---------- 视图：场次列表 ---------- */

async function renderShows() {
  app.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { shows } = await api('/api/shows');
    app.innerHTML = `
      <h1>场次（剧目）</h1>
      <div class="panel row">
        <input id="new-show-name" type="text" placeholder="新场次名称，如《茶馆》2026 巡演" class="grow">
        <button id="create-show">新建场次</button>
      </div>
      <div class="panel">
        ${shows.length === 0 ? '<p class="muted">还没有场次，请先新建。</p>' : `
        <table>
          <thead><tr><th>名称</th><th>版本数</th><th>已发布</th><th>演出场次</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            ${shows.map(s => `
              <tr>
                <td>${esc(s.name)}</td>
                <td>${s.version_count}</td>
                <td>${s.published_count}</td>
                <td>${s.performance_count}</td>
                <td class="muted">${fmtTime(s.created_at)}</td>
                <td><a href="#/shows/${s.id}">进入 →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>`;
    document.getElementById('create-show').onclick = async () => {
      const name = document.getElementById('new-show-name').value.trim();
      if (!name) return toast('请输入场次名称', true);
      try {
        const { show } = await api('/api/shows', { method: 'POST', body: { name } });
        location.hash = `#/shows/${show.id}`;
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

/* ---------- 视图：场次详情（版本 + 演出） ---------- */

async function renderShow(id) {
  app.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { show, versions, performances } = await api(`/api/shows/${id}`);
    const published = versions.filter(v => v.status === 'published');
    app.innerHTML = `
      <h1>${esc(show.name)}</h1>

      <h2>执行单版本</h2>
      <div class="panel">
        <div class="row" style="margin-bottom:12px">
          <button id="new-draft">＋ 新建草稿（基于最新版本）</button>
          <span class="muted">发布后内容不可变；修改请新建草稿再发布新版本</span>
        </div>
        ${versions.length === 0 ? '<p class="muted">暂无版本。</p>' : `
        <table>
          <thead><tr><th>版本</th><th>状态</th><th>备注</th><th>创建时间</th><th>发布时间</th><th></th></tr></thead>
          <tbody>
            ${versions.map(v => `
              <tr>
                <td>v${v.version_number}</td>
                <td><span class="badge ${v.status}">${v.status === 'published' ? '已发布' : '草稿'}</span></td>
                <td class="muted">${esc(v.note || '')}</td>
                <td class="muted">${fmtTime(v.created_at)}</td>
                <td class="muted">${v.published_at ? fmtTime(v.published_at) : '-'}</td>
                <td><a href="#/versions/${v.id}">${v.status === 'draft' ? '编辑' : '查看'} →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>

      <h2>启动演出</h2>
      <div class="panel row">
        ${published.length === 0
          ? '<span class="muted">无已发布版本，请先在上方编辑并发布执行单。</span>'
          : `
          <select id="perf-version">
            ${published.map(v => `<option value="${v.id}">v${v.version_number}${v.note ? '（' + esc(v.note) + '）' : ''}</option>`).join('')}
          </select>
          <input id="perf-name" type="text" placeholder="演出名称，如 9月30日 晚场">
          <input id="perf-operator" type="text" placeholder="启动人">
          <button id="start-perf">启动演出</button>`}
      </div>

      <h2>演出记录</h2>
      <div class="panel">
        ${performances.length === 0 ? '<p class="muted">暂无演出记录。</p>' : `
        <table>
          <thead><tr><th>#</th><th>名称</th><th>执行单版本</th><th>状态</th><th>接续关系</th><th>启动人</th><th>开始时间</th><th></th></tr></thead>
          <tbody>
            ${performances.map(p => `
              <tr>
                <td>${p.id}</td>
                <td>${esc(p.name || '（未命名）')}</td>
                <td>v${p.version_number}</td>
                <td>${p.status === 'readonly'
                    ? '<span class="badge readonly">只读 · 已接续</span>'
                    : '<span class="badge active">可操作</span>'}</td>
                <td class="muted">${p.continued_from_performance_id
                    ? `承接自 <a href="#/performances/${p.continued_from_performance_id}">#${p.continued_from_performance_id}（v${p.continued_from_version_number}）</a>`
                    : '—'}</td>
                <td>${esc(p.started_by || '-')}</td>
                <td class="muted">${fmtTime(p.started_at)}</td>
                <td><a href="#/performances/${p.id}">进入执行台 →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>`;

    document.getElementById('new-draft').onclick = async () => {
      try {
        const { version } = await api(`/api/shows/${id}/versions`, { method: 'POST', body: {} });
        toast(`已创建草稿 v${version.version_number}`);
        location.hash = `#/versions/${version.id}`;
      } catch (e) { toast(e.message, true); }
    };

    const startBtn = document.getElementById('start-perf');
    if (startBtn) startBtn.onclick = async () => {
      try {
        const { performance } = await api(`/api/shows/${id}/performances`, {
          method: 'POST',
          body: {
            version_id: Number(document.getElementById('perf-version').value),
            name: document.getElementById('perf-name').value.trim(),
            operator: document.getElementById('perf-operator').value.trim(),
          },
        });
        location.hash = `#/performances/${performance.id}`;
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

/* ---------- 视图：版本（草稿编辑器 / 已发布快照） ---------- */

let editorCues = null; // 当前草稿编辑内容

function collectEditorCues() {
  return editorCues.map(c => ({
    label: c.label.trim(),
    type: c.type,
    description: c.description.trim(),
    deps: c.depsText.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
    needs_review: !!c.needs_review,
  }));
}

function renderEditorTable() {
  const tbody = document.getElementById('editor-tbody');
  tbody.innerHTML = editorCues.map((c, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td><input type="text" class="label-input" data-i="${i}" data-f="label" value="${esc(c.label)}" placeholder="如 L1"></td>
      <td>
        <select data-i="${i}" data-f="type">
          ${Object.entries(TYPE_TEXT).map(([k, t]) =>
            `<option value="${k}" ${c.type === k ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" data-i="${i}" data-f="description" value="${esc(c.description)}" placeholder="提示内容描述"></td>
      <td><input type="text" class="deps-input" data-i="${i}" data-f="depsText" value="${esc(c.depsText)}" placeholder="前置编号，逗号分隔"></td>
      <td style="text-align:center"><input type="checkbox" data-i="${i}" data-f="needs_review" ${c.needs_review ? 'checked' : ''} title="现场触发需另一操作人复核确认"></td>
      <td style="white-space:nowrap">
        <button class="ghost small" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="ghost small" data-act="down" data-i="${i}" ${i === editorCues.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="danger small" data-act="del" data-i="${i}">删</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('input,select').forEach(el => {
    el.onchange = el.oninput = () => {
      const i = Number(el.dataset.i);
      const f = el.dataset.f;
      editorCues[i][f] = el.type === 'checkbox' ? el.checked : el.value;
    };
  });
  tbody.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i);
      const act = btn.dataset.act;
      if (act === 'del') editorCues.splice(i, 1);
      else if (act === 'up' && i > 0) [editorCues[i - 1], editorCues[i]] = [editorCues[i], editorCues[i - 1]];
      else if (act === 'down' && i < editorCues.length - 1) [editorCues[i + 1], editorCues[i]] = [editorCues[i], editorCues[i + 1]];
      renderEditorTable();
    };
  });
}

function showErrors(errors) {
  const box = document.getElementById('validate-result');
  if (!box) return;
  if (!errors || errors.length === 0) {
    box.innerHTML = '<div class="ok-box">✓ 校验通过：无缺失引用、无循环依赖</div>';
  } else {
    box.innerHTML = `<div class="error-list"><b>发现 ${errors.length} 个问题：</b><ul>${
      errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  }
}

async function renderVersion(id) {
  app.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { version, cues } = await api(`/api/versions/${id}`);
    const isDraft = version.status === 'draft';

    if (!isDraft) {
      // 已发布：只读快照（历史按当时版本回看）
      app.innerHTML = `
        <h1>执行单 v${version.version_number} <span class="badge published">已发布 · 不可变</span></h1>
        <p class="muted">发布于 ${fmtTime(version.published_at)}　${esc(version.note || '')}</p>
        <div class="panel">
          <table>
            <thead><tr><th>#</th><th>编号</th><th>类型</th><th>描述</th><th>前置提示</th><th>复核</th></tr></thead>
            <tbody>
              ${cues.map(c => `
                <tr>
                  <td class="muted">${c.seq}</td>
                  <td><b>${esc(c.label)}</b></td>
                  <td>${TYPE_TEXT[c.type] || c.type}</td>
                  <td>${esc(c.description)}</td>
                  <td>${c.deps.length ? c.deps.map(d => `<span class="dep-chip">${esc(d)}</span>`).join('') : '<span class="muted">无</span>'}</td>
                  <td>${c.needs_review ? '<span class="badge review">双人复核</span>' : '<span class="muted">—</span>'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="row">
          <a href="#/shows/${version.show_id}">← 返回场次</a>
          <button class="ghost" id="copy-draft">以此版本为基准新建草稿</button>
        </div>`;
      document.getElementById('copy-draft').onclick = async () => {
        try {
          const r = await api(`/api/shows/${version.show_id}/versions`, {
            method: 'POST', body: { from_version_id: version.id },
          });
          toast(`已创建草稿 v${r.version.version_number}`);
          location.hash = `#/versions/${r.version.id}`;
        } catch (e) { toast(e.message, true); }
      };
      return;
    }

    // 草稿编辑器
    editorCues = cues.map(c => ({
      label: c.label, type: c.type, description: c.description, depsText: c.deps.join(', '),
      needs_review: !!c.needs_review,
    }));

    app.innerHTML = `
      <h1>执行单 v${version.version_number} <span class="badge draft">草稿</span></h1>
      <p class="muted">前置提示填写其他提示的编号（逗号分隔）。勾选「复核」的提示现场触发时需另一操作人确认。保存不影响已开始的演出。</p>
      <div class="panel">
        <table class="editor-table">
          <thead><tr><th>#</th><th>编号</th><th>类型</th><th>描述</th><th>前置提示</th><th>复核</th><th>操作</th></tr></thead>
          <tbody id="editor-tbody"></tbody>
        </table>
        <div class="row" style="margin-top:12px">
          <button class="ghost" id="add-cue">＋ 添加提示</button>
        </div>
      </div>
      <div id="validate-result"></div>
      <div class="row">
        <button id="save-draft">保存草稿</button>
        <button class="ghost" id="validate-btn">校验</button>
        <button class="big" id="publish-btn">校验并发布</button>
        <a href="#/shows/${version.show_id}" style="margin-left:auto">← 返回场次</a>
      </div>`;

    renderEditorTable();

    document.getElementById('add-cue').onclick = () => {
      editorCues.push({ label: '', type: 'light', description: '', depsText: '' });
      renderEditorTable();
    };

    document.getElementById('save-draft').onclick = async () => {
      try {
        const r = await api(`/api/versions/${id}/cues`, {
          method: 'PUT', body: { cues: collectEditorCues() },
        });
        toast('草稿已保存');
        showErrors(r.errors);
      } catch (e) { toast(e.message, true); }
    };

    document.getElementById('validate-btn').onclick = async () => {
      try {
        const r = await api(`/api/versions/${id}/validate`, {
          method: 'POST', body: { cues: collectEditorCues() },
        });
        showErrors(r.errors);
      } catch (e) { toast(e.message, true); }
    };

    document.getElementById('publish-btn').onclick = async () => {
      try {
        // 先保存当前编辑内容，再发布
        const saved = await api(`/api/versions/${id}/cues`, {
          method: 'PUT', body: { cues: collectEditorCues() },
        });
        if (saved.errors && saved.errors.length) {
          showErrors(saved.errors);
          return toast('校验未通过，无法发布', true);
        }
        await api(`/api/versions/${id}/publish`, { method: 'POST', body: {} });
        toast('已发布，执行单不可再修改');
        renderVersion(id);
      } catch (e) {
        if (e.data && e.data.errors) showErrors(e.data.errors);
        toast(e.message, true);
      }
    };
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

/* ---------- 视图：演出执行台 ---------- */

// 接续面板展开状态按演出记忆（2.5s 轮询重绘时保留操作现场）
const continueUiState = new Map();
function getContinueState(perfId) {
  if (!continueUiState.has(perfId)) {
    continueUiState.set(perfId, { formOpen: false, preview: null, versionId: null, name: '', operator: '' });
  }
  return continueUiState.get(perfId);
}

async function renderPerformance(id) {
  try {
    const data = await api(`/api/performances/${id}`);
    drawPerformance(id, data);
    if (!pollTimer) {
      pollTimer = setInterval(async () => {
        try {
          const d = await api(`/api/performances/${id}`);
          drawPerformance(id, d);
        } catch (e) { connEl.textContent = '刷新失败'; }
      }, 2500);
    }
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

function drawPerformance(id, { performance: perf, continuation, continue_targets: targets, cues, events, review_requests: reviewRequests }) {
  // 2.5s 轮询整体重绘：记住当前焦点与光标位置，重绘后恢复，避免输入被打断
  const active = document.activeElement;
  const focusKey = active && (active.dataset.focusKey || (active.id === 'operator-input' ? 'operator' : null));
  const caret = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    ? { start: active.selectionStart, end: active.selectionEnd }
    : null;

  const counts = { pending: 0, fired: 0, skipped: 0, blocked: 0 };
  cues.forEach(c => counts[c.status]++);
  const requests = reviewRequests || [];
  const pendingReqs = requests.filter(r => r.status === 'pending');
  const resolvedReqs = requests.filter(r => r.status !== 'pending');
  const readonly = !!(continuation && continuation.readonly);
  const carriedCount = events.filter(e => e.source === 'carried').length;

  // 正在操作人框中输入时保留 DOM 中的实时值（下方 innerHTML 重绘前取出），避免光标跳尾
  const opFocused = focusKey === 'operator';
  const opVal = opFocused && active
    ? active.value
    : (document.getElementById('operator-input')
        ? document.getElementById('operator-input').value
        : (localStorage.getItem('operator') || ''));

  app.innerHTML = `
    <div class="perf-head">
      <h1 style="margin:4px 0">${esc(perf.show_name)} · ${esc(perf.name || '演出 #' + perf.id)}</h1>
      <div class="row muted" style="font-size:13px">
        <span>执行单 v${perf.version_number}（已发布快照）</span>
        ${readonly ? '<span class="badge readonly">只读 · 已接续</span>' : '<span class="badge active">可操作</span>'}
        <span>开始：${fmtTime(perf.started_at)}</span>
        <span>启动人：${esc(perf.started_by || '-')}</span>
        ${perf.continued_at ? `<span>接续时间：${fmtTime(perf.continued_at)}（${esc(perf.continued_by || '-')}）</span>` : ''}
        <span class="status pending">待执行 ${counts.pending}</span>
        <span class="status fired">已触发 ${counts.fired}</span>
        <span class="status skipped">已跳过 ${counts.skipped}</span>
        <span class="status blocked">受阻 ${counts.blocked}</span>
        ${pendingReqs.length ? `<span class="status review-pending">待复核 ${pendingReqs.length}</span>` : ''}
        <span class="grow"></span>
        <label>操作人 <input id="operator-input" type="text" value="${esc(opVal)}" placeholder="姓名" style="width:110px" ${readonly ? 'disabled' : ''}></label>
        <a href="#/shows/${perf.show_id}">返回场次</a>
      </div>
    </div>
    ${renderContinuationBanner(perf, continuation, carriedCount)}
    ${readonly ? '' : '<div id="batch-panel-mount"></div>'}
    ${readonly ? '' : '<div id="continue-panel-mount"></div>'}
    <div class="grid-2">
      <div id="cue-list">
        ${readonly && continuation.to
          ? `<div class="readonly-note">🔒 该演出已按修订执行单接续，保留原快照供回看，现场操作请前往<a href="#/performances/${continuation.to.performance_id}">接续演出 #${continuation.to.performance_id}（v${continuation.to.version_number}）</a>。</div>`
          : readonly
            ? '<div class="readonly-note">🔒 该演出已转为只读，保留原快照供回看。</div>'
            : ''}
        ${cues.map(c => cueCard(id, c, readonly)).join('')}
      </div>
      <div>
        <div class="panel review-panel">
          <b>复核申请（待处理 ${pendingReqs.length}）</b>
          ${readonly ? '<p class="muted">只读演出：申请记录可查，不能再处置。</p>' : ''}
          ${pendingReqs.length === 0 ? (readonly ? '' : '<p class="muted">暂无待复核申请</p>') : `
          <ul>
            ${pendingReqs.map(r => `
              <li>
                <span class="status review-pending">待复核</span>
                <b>${esc(r.label)}</b><br>
                <span class="muted">申请人 ${esc(r.requested_by)} · ${fmtTime(r.requested_at)}</span><br>
                <span class="review-actions">
                  <button class="small" data-req-act="confirm" data-req="${r.id}" ${readonly ? 'disabled' : ''}>确认触发</button>
                  <button class="danger small" data-req-act="reject" data-req="${r.id}" ${readonly ? 'disabled' : ''}>驳回</button>
                  <button class="ghost small" data-req-act="cancel" data-req="${r.id}" ${readonly ? 'disabled' : ''}>撤销</button>
                </span>
              </li>`).join('')}
          </ul>`}
          ${resolvedReqs.length === 0 ? '' : `
          <b class="review-history-title">处置记录</b>
          <ul>
            ${resolvedReqs.map(r => `
              <li>
                <span class="status review-${r.status}">${REQUEST_STATUS_TEXT[r.status]}</span>
                <b>${esc(r.label)}</b><br>
                <span class="muted">申请人 ${esc(r.requested_by)} · ${fmtTime(r.requested_at)}<br>
                处置 ${esc(r.resolved_by || '-')} · ${fmtTime(r.resolved_at)}${r.resolve_reason ? '<br>原因：' + esc(r.resolve_reason) : ''}</span>
              </li>`).join('')}
          </ul>`}
        </div>
        <div class="panel event-log">
          <b>执行记录（最新在上）</b>
          ${events.length === 0 ? '<p class="muted">暂无记录</p>' : `
          <ul>
            ${events.map(e => `
              <li>
                <span class="status ${e.action}">${ACTION_TEXT(e.action)}</span>
                <b>${esc(e.label)}</b>
                ${e.source === 'carried'
                  ? `<span class="badge carried" title="接续时自演出 #${esc(e.carried_from_performance_id)} 承接，非现场再次触发">承接自 #${esc(e.carried_from_performance_id)}</span>`
                  : ''}
                <br>
                <span class="muted">${esc(e.operator)} · ${fmtTime(e.created_at)}${e.reason ? '<br>原因：' + esc(e.reason) : ''}</span>
              </li>`).join('')}
          </ul>`}
        </div>
      </div>
    </div>`;

  const opInput = document.getElementById('operator-input');
  if (opInput) opInput.onchange = opInput.oninput = () => localStorage.setItem('operator', opInput.value.trim());

  if (readonly) return;

  cues.forEach(c => {
    const fireBtn = document.getElementById(`fire-${c.id}`);
    const skipBtn = document.getElementById(`skip-${c.id}`);
    const retractBtn = document.getElementById(`retract-${c.id}`);
    if (fireBtn) fireBtn.onclick = () => doFire(id, c.id);
    if (skipBtn) skipBtn.onclick = () => doSkip(id, c.id);
    if (retractBtn) retractBtn.onclick = () => doRetract(id, c.id);
  });

  app.querySelectorAll('[data-req-act]').forEach(btn => {
    btn.onclick = () => {
      const reqId = btn.dataset.req;
      const act = btn.dataset.reqAct;
      if (act === 'confirm') doConfirmRequest(id, reqId);
      else if (act === 'reject') doRejectRequest(id, reqId);
      else if (act === 'cancel') doCancelRequest(id, reqId);
    };
  });

  drawBatchPanel(id, cues);
  drawContinuePanel(id, targets || []);

  // 恢复焦点（轮询重绘不打断操作人/成组表单输入）
  if (focusKey) {
    const sel = focusKey === 'operator'
      ? document.getElementById('operator-input')
      : document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (sel) {
      sel.focus();
      if (caret && sel.setSelectionRange) {
        try { sel.setSelectionRange(caret.start, caret.end); } catch (_) {}
      }
    }
  }
}

/* ---------- 现场成组处置面板 ---------- */

// 成组面板状态按演出记忆：清单编辑内容与最近一次逐项预览（轮询重绘不丢失操作现场）
const batchUiState = new Map();
function getBatchState(perfId) {
  if (!batchUiState.has(perfId)) {
    batchUiState.set(perfId, { open: true, rows: [emptyBatchRow()], preview: null });
  }
  return batchUiState.get(perfId);
}
function emptyBatchRow() {
  return { label: '', action: 'fire', reason: '' };
}
const BATCH_ACTION_TEXTS = { fire: '触发', skip: '跳过', retract: '撤回' };

function collectBatchRows(st) {
  st.rows = st.rows.map(r => ({
    label: r.label.trim(),
    action: BATCH_ACTION_TEXTS[r.action] ? r.action : 'fire',
    reason: r.reason.trim(),
  }));
  return st.rows;
}

function drawBatchPanel(perfId, cues) {
  const mount = document.getElementById('batch-panel-mount');
  if (!mount) return;
  const st = getBatchState(perfId);
  if (!st.open) {
    mount.innerHTML = `
      <div class="panel batch-panel collapsed">
        <div class="row">
          <b>📋 成组连续处置</b>
          <span class="muted">按顺序逐项触发 / 跳过 / 撤回，先预览判定再整组提交（需双人复核的提示请走单项申请）</span>
          <span class="grow"></span>
          <button class="ghost small" id="batch-toggle">展开</button>
        </div>
      </div>`;
    document.getElementById('batch-toggle').onclick = () => { st.open = true; drawBatchPanel(perfId, cues); };
    return;
  }

  const labels = cues.map(c => c.label);
  mount.innerHTML = `
    <div class="panel batch-panel">
      <div class="row">
        <b>📋 成组连续处置</b>
        <span class="muted">按清单顺序逐项判定：前置、下游撤回保护、待复核限制均以前面步骤的有效结果为准；整组全部通过才依次落流水</span>
        <span class="grow"></span>
        <button class="ghost small" id="batch-toggle">收起</button>
      </div>
      <div class="batch-table-wrap">
        <table class="batch-table">
          <thead><tr><th style="width:42px">#</th><th style="width:130px">编号</th><th style="width:96px">动作</th><th>跳过 / 撤回原因（触发无需填写）</th><th style="width:42px"></th></tr></thead>
          <tbody>
            ${st.rows.map((r, i) => `
              <tr>
                <td class="muted">${i + 1}</td>
                <td><input class="batch-label" type="text" list="cue-labels-${perfId}" data-focus-key="batch-${perfId}-label-${i}" value="${esc(r.label)}" placeholder="如 L2"></td>
                <td>
                  <select class="batch-action" data-focus-key="batch-${perfId}-action-${i}">
                    <option value="fire" ${r.action === 'fire' ? 'selected' : ''}>触发</option>
                    <option value="skip" ${r.action === 'skip' ? 'selected' : ''}>跳过</option>
                    <option value="retract" ${r.action === 'retract' ? 'selected' : ''}>撤回</option>
                  </select>
                </td>
                <td><input class="batch-reason" type="text" data-focus-key="batch-${perfId}-reason-${i}" value="${esc(r.reason)}" placeholder="${r.action === 'skip' ? '跳过原因（必填）' : r.action === 'retract' ? '撤回原因（必填）' : '触发无需原因'}" ${r.action === 'fire' ? 'disabled' : ''}></td>
                <td><button class="ghost danger small batch-del" data-i="${i}" ${st.rows.length === 1 ? 'disabled' : ''}>删</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <datalist id="cue-labels-${perfId}">
          ${labels.map(l => `<option value="${esc(l)}"></option>`).join('')}
        </datalist>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ghost small" id="batch-add">＋ 添加一项</button>
        <span class="grow"></span>
        <button class="ghost" id="batch-preview">逐项预览</button>
        <button class="big" id="batch-submit">整组提交</button>
      </div>
      <div id="batch-result"></div>
    </div>`;

  const bindRowInputs = () => {
    mount.querySelectorAll('tbody tr').forEach((tr, i) => {
      const labelEl = tr.querySelector('.batch-label');
      const actionSel = tr.querySelector('.batch-action');
      const reasonEl = tr.querySelector('.batch-reason');
      labelEl.oninput = () => { st.rows[i].label = labelEl.value; st.preview = null; };
      actionSel.onchange = () => {
        st.rows[i].action = actionSel.value;
        if (actionSel.value === 'fire') st.rows[i].reason = '';
        st.preview = null;
        drawBatchPanel(perfId, cues);
      };
      reasonEl.oninput = () => { st.rows[i].reason = reasonEl.value; st.preview = null; };
      tr.querySelector('.batch-del').onclick = () => {
        st.rows.splice(i, 1);
        st.preview = null;
        drawBatchPanel(perfId, cues);
      };
    });
  };
  bindRowInputs();

  document.getElementById('batch-toggle').onclick = () => { st.open = false; drawBatchPanel(perfId, cues); };
  document.getElementById('batch-add').onclick = () => {
    st.rows.push(emptyBatchRow());
    st.preview = null;
    drawBatchPanel(perfId, cues);
  };
  document.getElementById('batch-preview').onclick = () => doBatchPreview(perfId, cues);
  document.getElementById('batch-submit').onclick = () => doBatchSubmit(perfId, cues);
  renderBatchResult(perfId);
}

function renderBatchResult(perfId) {
  const box = document.getElementById('batch-result');
  if (!box) return;
  const st = getBatchState(perfId);
  const pv = st.preview;
  if (!pv) {
    box.innerHTML = '<p class="muted" style="margin:8px 0 0">按现场顺序填写编号与动作后「逐项预览」：每一步会基于前面步骤的有效结果判定前置、下游与待复核限制。</p>';
    return;
  }
  const rowsHtml = pv.results.map(r => `
    <tr class="${r.ok ? 'batch-ok' : 'batch-fail'}">
      <td>${r.index}</td>
      <td><b>${esc(r.label)}</b></td>
      <td>${BATCH_ACTION_TEXTS[r.action] || r.action}${r.ok && r.planned ? ' <span class="hint-flag flag-carried">拟执行</span>' : ''}</td>
      <td>${r.ok
        ? `<span class="status fired">✓ 通过</span>${r.reason ? '<div class="muted">' + esc(r.reason) + '</div>' : ''}`
        : `<span class="status blocked">✗ ${esc(r.error)}</span>`}</td>
    </tr>`).join('');
  const head = pv.can_submit
    ? `<div class="ok-box">✓ 逐项预览全部通过（${pv.success_count} 项）：提交时按最新状态重新逐项判定，全部通过才依次写入与单项一致的流水。</div>`
    : `<div class="error-list"><b>预览发现 ${pv.failure_count} 项不能执行（${pv.success_count} 项可执行）：</b>请按失败项调整清单后再提交；正式提交时任一项失败，整组均不产生流水。</div>`;
  box.innerHTML = `
    ${head}
    <div class="hint-table-wrap">
      <table class="hint-table batch-preview-table">
        <thead><tr><th style="width:42px">序号</th><th style="width:110px">编号</th><th style="width:150px">动作</th><th>判定结果 / 失败原因</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

async function doBatchPreview(perfId) {
  const st = getBatchState(perfId);
  const operator = getOperator();
  if (!operator) { toast('请先填写本组操作人（顶部操作人输入框）', true); return document.getElementById('operator-input').focus(); }
  collectBatchRows(st);
  if (!st.rows.length) return toast('成组清单为空', true);
  try {
    st.preview = await api(`/api/performances/${perfId}/batch/preview`, {
      method: 'POST',
      body: { operator, items: st.rows.map(r => ({ label: r.label, action: r.action, reason: r.reason })) },
    });
    renderBatchResult(perfId);
  } catch (e) {
    st.preview = null;
    toast(e.message, true);
    renderBatchResult(perfId);
  }
}

async function doBatchSubmit(perfId, cues) {
  const st = getBatchState(perfId);
  const operator = getOperator();
  if (!operator) { toast('请先填写本组操作人（顶部操作人输入框）', true); return document.getElementById('operator-input').focus(); }
  collectBatchRows(st);
  if (!st.rows.length) return toast('成组清单为空', true);

  // 提交前先按当前编辑做一次逐项预览（服务端事务内仍会按最新状态再判定一次）
  let pv;
  try {
    pv = await api(`/api/performances/${perfId}/batch/preview`, {
      method: 'POST',
      body: { operator, items: st.rows.map(r => ({ label: r.label, action: r.action, reason: r.reason })) },
    });
    st.preview = pv;
    renderBatchResult(perfId);
  } catch (e) {
    st.preview = null;
    renderBatchResult(perfId);
    return toast(e.message, true);
  }
  if (!pv.can_submit) {
    return toast('逐项预览存在失败项，请调整后再提交', true);
  }
  if (!window.confirm(`成组 ${pv.success_count} 项预览均通过。确认按顺序整组提交？\n（提交瞬间按最新状态重新判定，任一项失败则整组不产生流水）`)) return;

  try {
    const r = await api(`/api/performances/${perfId}/batch`, {
      method: 'POST',
      body: { operator, items: st.rows.map(row2 => ({ label: row2.label, action: row2.action, reason: row2.reason })) },
    });
    st.rows = [emptyBatchRow()];
    st.preview = null;
    toast(`成组提交成功：已依次写入 ${r.success_count} 条执行流水`);
  } catch (e) {
    // 服务端事务内重新判定发现失败：整组未生效、无流水；用返回的逐项结果替换预览
    if (e.data && Array.isArray(e.data.results)) {
      st.preview = {
        results: e.data.results,
        success_count: e.data.success_count,
        failure_count: e.data.failure_count,
        can_submit: false,
      };
      renderBatchResult(perfId);
    }
    toast(e.message, true);
  }
  // 成功或失败都重新拉取执行台最新状态（成功后提示卡片/流水更新）
  stopPolling();
  renderPerformance(perfId);
}

/* ---------- 接续关系横幅与接续面板 ---------- */

function renderContinuationBanner(perf, continuation, carriedCount) {
  if (!continuation) return '';
  const parts = [];
  if (continuation.from) {
    const f = continuation.from;
    parts.push(`<span class="chain-chip from">↩ 承接自 <a href="#/performances/${f.performance_id}">演出 #${f.performance_id}（v${f.version_number}${f.name ? ' · ' + esc(f.name) : ''}）</a>${carriedCount ? `，已继承 ${carriedCount} 条有效结果` : ''}</span>`);
  }
  if (continuation.to) {
    const t = continuation.to;
    parts.push(`<span class="chain-chip to">↪ 已接续到 <a href="#/performances/${t.performance_id}">演出 #${t.performance_id}（v${t.version_number}${t.name ? ' · ' + esc(t.name) : ''}）</a>（${fmtTime(perf.continued_at)}，${esc(perf.continued_by || '-')}）</span>`);
  }
  return parts.length ? `<div class="continuation-banner">${parts.join('')}</div>` : '';
}

function drawContinuePanel(perfId, targets) {
  const mount = document.getElementById('continue-panel-mount');
  if (!mount) return;
  const st = getContinueState(perfId);

  if (!targets.length) {
    mount.innerHTML = `
      <div class="panel continue-panel disabled">
        <div class="row">
          <b>改用修订执行单（接续演出）</b>
          <span class="muted">暂无同场次更高且已发布的版本；请先在排演端新建草稿、发布新版本后再接续。</span>
        </div>
      </div>`;
    return;
  }

  mount.innerHTML = `
    <div class="panel continue-panel">
      <div class="row">
        <b>改用修订执行单（接续演出）</b>
        <span class="muted">原演出保留原快照并转为只读；有效结果由新版继承并标注承接，不会再次触发</span>
        <span class="grow"></span>
        <button class="ghost small" id="continue-toggle">${st.formOpen ? '收起' : '发起接续'}</button>
      </div>
      ${st.formOpen ? `
      <div class="continue-form">
        <div class="row" style="margin-top:10px">
          <label>目标版本
            <select id="continue-version">
              ${targets.map(v => `<option value="${v.id}" ${(st.versionId || v.id) === v.id ? 'selected' : ''}>v${v.version_number}${v.note ? '（' + esc(v.note) + '）' : ''}</option>`).join('')}
            </select>
          </label>
          <input id="continue-name" type="text" placeholder="接续演出名称（可选，默认追加「接续」）" class="grow" value="${esc(st.name)}">
          <input id="continue-operator" type="text" placeholder="操作人（必填）" value="${esc(st.operator || getOperator())}">
          <button class="ghost" id="continue-preview">按编号核对</button>
          <button id="continue-run">生成接续演出</button>
        </div>
        <div id="continue-result"></div>
      </div>` : ''}
    </div>`;

  document.getElementById('continue-toggle').onclick = () => {
    st.formOpen = !st.formOpen;
    drawContinuePanel(perfId, targets);
  };

  if (!st.formOpen) return;
  // 轮询重绘时保留表单输入；切换目标版本后旧核对结果作废，需重新核对
  const verSel = document.getElementById('continue-version');
  if (!st.versionId) st.versionId = Number(verSel.value);
  verSel.onchange = () => {
    st.versionId = Number(verSel.value);
    st.preview = null;
    renderContinueResult(perfId);
  };
  const nameInput = document.getElementById('continue-name');
  const opInput2 = document.getElementById('continue-operator');
  nameInput.oninput = () => { st.name = nameInput.value; };
  opInput2.oninput = () => { st.operator = opInput2.value; };
  document.getElementById('continue-preview').onclick = () => doContinuePreview(perfId);
  document.getElementById('continue-run').onclick = () => doContinueRun(perfId);
  renderContinueResult(perfId);
}

function HINT_TEXT(f) {
  return ({ fired: '触发', skipped: '跳过', retracted: '撤回', review: '复核申请', carried: '承接' })[f] || f;
}

function renderContinueResult(perfId) {
  const box = document.getElementById('continue-result');
  if (!box) return;
  const st = getContinueState(perfId);
  const pv = st.preview;
  if (!pv) {
    box.innerHTML = '<p class="muted" style="margin:8px 0 0">先「按编号核对」查看原演出及其接续来源中的触发 / 跳过 / 撤回流水、复核申请与承接结果。</p>';
    return;
  }

  const hintsHtml = pv.hints.length === 0 ? '<p class="muted">无任何已执行痕迹。</p>' : `
    <details open>
      <summary class="muted">按编号核对（${pv.hints.length} 个编号有痕迹）</summary>
      <div class="hint-table-wrap">
        <table class="hint-table">
          <thead><tr><th>编号</th><th>痕迹</th><th>记录数</th></tr></thead>
          <tbody>
            ${pv.hints.map(h => `
              <tr>
                <td><b>${esc(h.label)}</b></td>
                <td>${h.flags.map(f => `<span class="hint-flag flag-${f}">${esc(HINT_TEXT(f))}</span>`).join('')}</td>
                <td class="muted">${h.records.length}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </details>`;

  const carriedHtml = pv.carried.length
    ? `<p class="muted" style="margin:6px 0">将继承 ${pv.carried.length} 条有效结果：${pv.carried.map(c => `<span class="hint-flag flag-${c.action}">${esc(c.label)} ${ACTION_TEXT(c.action)}</span>`).join(' ')}</p>`
    : '<p class="muted" style="margin:6px 0">当前无有效结果需要继承（撤回与未执行的提示不承接，按新版依赖重新计算状态）。</p>';

  if (pv.can_continue) {
    box.innerHTML = `<div class="ok-box">✓ 核对通过：编号、类型、描述、前置集合、复核标记均保留，无待处理申请，可以接续。</div>${carriedHtml}${hintsHtml}`;
  } else {
    box.innerHTML = `
      <div class="error-list"><b>存在 ${pv.conflicts.length} 个冲突编号，原演出保持可操作、不会产生接续：</b>
        <ul>${pv.conflicts.map(c => `<li><b>${esc(c.label)}</b>：${c.reasons.map(esc).join('；')}</li>`).join('')}</ul>
      </div>${carriedHtml}${hintsHtml}`;
  }
}

async function loadContinuePreview(perfId) {
  const st = getContinueState(perfId);
  const versionId = st.versionId || Number(document.getElementById('continue-version').value);
  st.versionId = versionId;
  return api(`/api/performances/${perfId}/continue/preview`, {
    method: 'POST', body: { version_id: versionId },
  });
}

async function doContinuePreview(perfId) {
  try {
    getContinueState(perfId).preview = await loadContinuePreview(perfId);
    renderContinueResult(perfId);
  } catch (e) { toast(e.message, true); }
}

async function doContinueRun(perfId) {
  const st = getContinueState(perfId);
  const operator = (document.getElementById('continue-operator').value || '').trim();
  st.operator = operator;
  if (!operator) return toast('请填写操作人', true);
  const versionId = st.versionId || Number(document.getElementById('continue-version').value);
  const name = (document.getElementById('continue-name').value || '').trim();
  st.name = name;

  // 执行前再次核对，服务端事务内还会串行复核一次
  try {
    const pv = await loadContinuePreview(perfId);
    getContinueState(perfId).preview = pv;
    if (!pv.can_continue) {
      renderContinueResult(perfId);
      return toast('核对未通过，请先处理冲突编号', true);
    }
  } catch (e) { return toast(e.message, true); }

  if (!window.confirm('确认生成接续演出？原演出将立即转为只读（保留原快照）。')) return;
  try {
    const r = await api(`/api/performances/${perfId}/continue`, {
      method: 'POST', body: { version_id: versionId, name, operator },
    });
    continueUiState.delete(r.performance.id);
    toast(`已生成接续演出 #${r.performance.id}，继承 ${r.carried_count} 条有效结果`);
    location.hash = `#/performances/${r.performance.id}`;
  } catch (e) {
    // 事务内串行判定发现冲突：刷新核对结果，原演出未改变
    if (e.data && e.data.conflicts) {
      try { getContinueState(perfId).preview = await loadContinuePreview(perfId); renderContinueResult(perfId); } catch (_) {}
    }
    toast(e.message, true);
  }
}

function ACTION_TEXT(a) {
  return a === 'fired' ? '已触发' : a === 'skipped' ? '已跳过' : '已撤回';
}

function cueCard(perfId, c, readonly) {
  const depsHtml = c.deps.length
    ? c.deps.map(d => `<span class="dep-chip ${c.unmet.includes(d) ? 'unmet-chip' : 'met'}">${esc(d)}</span>`).join('')
    : '<span class="muted">无前置</span>';
  const eventHtml = c.event
    ? `<div class="cue-event">${ACTION_TEXT(c.event.action)} · ${esc(c.event.operator)} · ${fmtTime(c.event.created_at)}${c.event.reason ? ' · 原因：' + esc(c.event.reason) : ''}${c.event.source === 'carried' ? ' · <span class="carried-text">承接自演出 #' + esc(c.event.carried_from_performance_id) + '</span>' : ''}</div>`
    : '';
  const blockedHtml = c.status === 'blocked'
    ? `<div class="cue-event"><span class="unmet">受阻：前置 ${c.unmet.map(esc).join('、')} 未触发</span></div>`
    : '';
  const req = c.pending_request;
  const reviewHtml = req
    ? `<div class="cue-event"><span class="review-pending-text">待复核：${esc(req.requested_by)} 于 ${fmtTime(req.requested_at)} 申请触发，需另一操作人确认</span></div>`
    : '';
  const canAct = !readonly && c.status === 'pending' && !req;
  const done = c.status === 'fired' || c.status === 'skipped';
  const canRetract = !readonly && c.status === 'fired';
  const fireLabel = c.needs_review ? '申请触发' : '触发';
  return `
    <div class="cue-card ${c.status}">
      <div class="cue-seq">${c.seq}</div>
      <div class="cue-main">
        <div class="cue-title">
          <span class="cue-label">${esc(c.label)}</span>
          <span class="cue-type">${TYPE_TEXT[c.type] || c.type}</span>
          ${c.needs_review ? '<span class="badge review">双人复核</span>' : ''}
          ${c.event && c.event.source === 'carried' ? '<span class="badge carried">承接</span>' : ''}
          <span class="status ${c.status}">${STATUS_TEXT[c.status]}</span>
        </div>
        ${c.description ? `<div class="cue-desc">${esc(c.description)}</div>` : ''}
        <div class="cue-deps">前置：${depsHtml}</div>
        ${blockedHtml}
        ${reviewHtml}
        ${eventHtml}
      </div>
      <div class="cue-actions">
        <button id="fire-${c.id}" ${canAct ? '' : 'disabled'}>${fireLabel}</button>
        <button id="skip-${c.id}" class="ghost" ${(!readonly && !done && !req) ? '' : 'disabled'}>跳过</button>
        <button id="retract-${c.id}" class="danger" ${canRetract ? '' : 'disabled'}>撤回</button>
      </div>
    </div>`;
}

async function doFire(perfId, cueId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  try {
    const r = await api(`/api/performances/${perfId}/cues/${cueId}/fire`, { method: 'POST', body: { operator } });
    if (r.request) toast('已提交触发申请，待另一操作人复核确认');
  } catch (e) {
    toast(e.message, true); // 409 冲突 / 422 受阻等，消息含当前状态
  }
  stopPolling();
  renderPerformance(perfId);
}

async function doSkip(perfId, cueId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  const reason = window.prompt('请填写跳过原因（必填）：');
  if (reason == null) return;
  if (!reason.trim()) return toast('跳过必须填写原因', true);
  try {
    await api(`/api/performances/${perfId}/cues/${cueId}/skip`, {
      method: 'POST', body: { operator, reason: reason.trim() },
    });
  } catch (e) {
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}

async function doRetract(perfId, cueId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  const reason = window.prompt('请填写撤回原因（必填，如：误触发）：');
  if (reason == null) return;
  if (!reason.trim()) return toast('撤回必须填写原因', true);
  try {
    await api(`/api/performances/${perfId}/cues/${cueId}/retract`, {
      method: 'POST', body: { operator, reason: reason.trim() },
    });
    toast('已撤回，该提示可重新执行');
  } catch (e) {
    // 409：当前状态不允许撤回，或下游仍有已触发提示（消息含受影响编号）
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}

/* ---------- 双人复核：确认 / 驳回 / 撤销 ---------- */

async function doConfirmRequest(perfId, reqId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人（须与申请人不同）', true); return document.getElementById('operator-input').focus(); }
  try {
    await api(`/api/performances/${perfId}/review-requests/${reqId}/confirm`, {
      method: 'POST', body: { operator },
    });
    toast('已确认，提示触发成功');
  } catch (e) {
    // 409：申请已处置 / 确认人与申请人相同；422：前置未触发（申请保持待复核）
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}

async function doRejectRequest(perfId, reqId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  const reason = window.prompt('请填写驳回原因（必填）：');
  if (reason == null) return;
  if (!reason.trim()) return toast('驳回必须填写原因', true);
  try {
    await api(`/api/performances/${perfId}/review-requests/${reqId}/reject`, {
      method: 'POST', body: { operator, reason: reason.trim() },
    });
    toast('已驳回该申请');
  } catch (e) {
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}

async function doCancelRequest(perfId, reqId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人（须为申请人本人）', true); return document.getElementById('operator-input').focus(); }
  try {
    await api(`/api/performances/${perfId}/review-requests/${reqId}/cancel`, {
      method: 'POST', body: { operator },
    });
    toast('已撤销该申请');
  } catch (e) {
    // 409：非申请人本人 / 申请已处置
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}
