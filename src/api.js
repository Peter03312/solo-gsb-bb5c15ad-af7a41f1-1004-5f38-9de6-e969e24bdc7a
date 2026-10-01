'use strict';
/**
 * API 路由与业务逻辑。
 * 错误约定：返回 { error: 消息, ... } ，状态码语义：
 *   400 参数/前置条件错误（含无已发布版本、版本未发布、跳过/撤回/驳回缺原因）
 *   404 资源不存在
 *   409 冲突（提示已有结果、版本已发布不可改、撤回时当前状态不允许或下游仍已触发、
 *       复核申请重复/已处置/处置人身份不符、待复核期间跳过或撤回、
 *       对只读（已接续）演出执行现场操作或接续、接续核对存在编号冲突）
 *   422 校验未通过（缺失引用/循环依赖）或前置未触发（受阻，含复核确认时前置失效）
 */
const { db, withTx } = require('./db');
const { validateCues, CUE_TYPES } = require('./validate');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

/* ---------------- 工具 ---------------- */

const ACTION_TEXT = { fired: '已触发', skipped: '已跳过', retracted: '已撤回' };
const REQUEST_STATUS_TEXT = { pending: '待复核', confirmed: '已确认', cancelled: '已撤销', rejected: '已驳回' };
// 接续核对提示标记：触发 / 跳过 / 撤回流水、复核申请、承接结果
const HINT_FLAG_TEXT = {
  fired: '有触发流水',
  skipped: '有跳过流水',
  retracted: '有撤回流水',
  review: '有复核申请',
  carried: '有承接结果',
};

function sanitizeCue(raw) {
  const deps = Array.isArray(raw && raw.deps) ? raw.deps : [];
  return {
    label: String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50),
    type: CUE_TYPES.includes(raw && raw.type) ? raw.type : 'other',
    description: String((raw && raw.description) != null ? raw.description : '').trim().slice(0, 500),
    deps: [...new Set(deps.map((d) => String(d).trim()).filter(Boolean))].slice(0, 50),
    needs_review: raw && raw.needs_review ? 1 : 0,
  };
}

function getShow(id) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!show) throw new HttpError(404, '场次不存在');
  return show;
}

function getVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) throw new HttpError(404, '版本不存在');
  return v;
}

function getVersionCues(versionId) {
  return db
    .prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq')
    .all(versionId)
    .map((c) => ({ ...c, deps: JSON.parse(c.deps) }));
}

function conflictError(existing) {
  return new HttpError(
    409,
    `该提示已有结果：${ACTION_TEXT[existing.action]}（操作人 ${existing.operator}，时间 ${existing.created_at}）`,
    { current: existing }
  );
}

/**
 * 演出内各提示的最新一条事件（cue_id -> event）。
 * 当前有效结果规则：最新事件为 fired/skipped 即有效；retracted（已撤回）或无事件 = 无有效结果。
 * 所有写操作在 BEGIN IMMEDIATE 事务内"读最新→判定→写入"，保证至多一个当前有效结果。
 */
function latestEventsByCue(performanceId) {
  const rows = db.prepare('SELECT * FROM cue_events WHERE performance_id = ? ORDER BY id').all(performanceId);
  const map = new Map();
  for (const e of rows) map.set(e.cue_id, e);
  return map;
}

function effectiveAction(latest) {
  return latest && latest.action !== 'retracted' ? latest.action : null;
}

/** 演出与提示的存在性校验（提示须属于演出锁定的版本），供各写操作复用。
 *  在写事务内调用：同时拒绝已转只读（已接续）的演出，保证接续与现场操作串行判定。 */
function getPerfCue(performanceId, cueId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  assertActiveInTx(perf);
  const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
  if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');
  return { perf, cue };
}

/** 已接续的原演出为只读：拒绝一切现场操作（须在 BEGIN IMMEDIATE 事务内调用以读到最新状态） */
function assertActiveInTx(perf) {
  if (perf && perf.status === 'readonly') {
    const next = db.prepare(
      'SELECT np.id, np.name, v.version_number FROM performances np JOIN versions v ON v.id = np.version_id WHERE np.continued_from_performance_id = ? ORDER BY np.id LIMIT 1'
    ).get(perf.id);
    throw new HttpError(
      409,
      `该演出已按修订执行单接续（接续时间 ${perf.continued_at || '-'}，操作人 ${perf.continued_by || '-'}），原演出保持原快照且为只读，请到接续演出继续操作`,
      {
        readonly: true,
        continued_at: perf.continued_at || null,
        continued_by: perf.continued_by || null,
        ...(next
          ? { continuation: { performance_id: next.id, name: next.name, version_number: next.version_number } }
          : {}),
      }
    );
  }
}

/** 该演出某提示当前待复核的申请（无则 null）。须在事务内调用以保证判定一致 */
function pendingRequestFor(performanceId, cueId) {
  return db.prepare(
    "SELECT * FROM cue_review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(performanceId, cueId) || null;
}

/** 当前有效结果为"已触发"的提示编号集合（已撤回的不算） */
function firedLabelSet(versionId, latestByCue) {
  const rows = db.prepare('SELECT id, label FROM cues WHERE version_id = ?').all(versionId);
  return new Set(
    rows.filter((r) => {
      const e = latestByCue.get(r.id);
      return e && e.action === 'fired';
    }).map((r) => r.label)
  );
}

/* ---------------- 路由表 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, rx, keys, handler });
}

/* ---- 场次 ---- */

route('GET', '/api/shows', () => {
  const shows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id) AS version_count,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id AND v.status = 'published') AS published_count,
      (SELECT COUNT(*) FROM performances p WHERE p.show_id = s.id) AS performance_count
    FROM shows s ORDER BY s.id DESC
  `).all();
  return { shows };
});

route('POST', '/api/shows', (body) => {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, '场次名称不能为空');
  const info = db.prepare('INSERT INTO shows (name) VALUES (?)').run(name);
  return { show: db.prepare('SELECT * FROM shows WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/shows/:id', (body, p) => {
  const show = getShow(p.id);
  const versions = db.prepare(
    'SELECT id, show_id, version_number, status, note, created_at, published_at FROM versions WHERE show_id = ? ORDER BY version_number DESC'
  ).all(show.id);
  const performances = db.prepare(`
    SELECT p.*, v.version_number,
      p2.name AS continued_from_name, v2.version_number AS continued_from_version_number
    FROM performances p
    JOIN versions v ON v.id = p.version_id
    LEFT JOIN performances p2 ON p2.id = p.continued_from_performance_id
    LEFT JOIN versions v2 ON v2.id = p2.version_id
    WHERE p.show_id = ? ORDER BY p.id DESC
  `).all(show.id);
  return { show, versions, performances };
});

/* ---- 版本（执行单） ---- */

route('POST', '/api/shows/:id/versions', (body, p) => {
  const show = getShow(p.id);
  return withTx(() => {
    // 基准版本：指定 from_version_id，否则取最新版本；没有则建空白草稿
    let base = null;
    if (body.from_version_id != null) {
      base = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?')
        .get(body.from_version_id, show.id);
      if (!base) throw new HttpError(404, '基准版本不存在');
    } else {
      base = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_number DESC LIMIT 1')
        .get(show.id);
    }
    const nextNo = (db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM versions WHERE show_id = ?')
      .get(show.id).m) + 1;
    const info = db.prepare('INSERT INTO versions (show_id, version_number, status, note) VALUES (?,?,?,?)')
      .run(show.id, nextNo, 'draft', String(body.note || '').slice(0, 200));
    const newId = Number(info.lastInsertRowid);
    if (base) {
      const cues = db.prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq').all(base.id);
      const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review) VALUES (?,?,?,?,?,?,?)');
      for (const c of cues) ins.run(newId, c.seq, c.label, c.type, c.description, c.deps, c.needs_review);
    }
    return { version: getVersion(newId), cues: getVersionCues(newId) };
  });
});

route('GET', '/api/versions/:id', (body, p) => {
  const version = getVersion(p.id);
  return { version, cues: getVersionCues(version.id) };
});

route('PUT', '/api/versions/:id/cues', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') {
    throw new HttpError(409, '该版本已发布，内容不可修改；请新建草稿版本');
  }
  if (!Array.isArray(body.cues)) throw new HttpError(400, '请求格式错误：cues 应为数组');
  if (body.cues.length > 500) throw new HttpError(400, '提示数量过多（上限 500）');

  const cues = body.cues.map(sanitizeCue);
  withTx(() => {
    db.prepare('DELETE FROM cues WHERE version_id = ?').run(version.id);
    const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review) VALUES (?,?,?,?,?,?,?)');
    cues.forEach((c, i) => ins.run(version.id, i + 1, c.label, c.type, c.description, JSON.stringify(c.deps), c.needs_review));
  });
  // 草稿允许暂存不完整内容，同时返回校验结果供界面提示
  return { ok: true, errors: validateCues(cues), cues: getVersionCues(version.id) };
});

route('POST', '/api/versions/:id/validate', (body, p) => {
  getVersion(p.id);
  const cues = Array.isArray(body.cues) ? body.cues.map(sanitizeCue) : getVersionCues(p.id);
  return { errors: validateCues(cues) };
});

route('POST', '/api/versions/:id/publish', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') throw new HttpError(409, '该版本已发布');
  const cues = getVersionCues(version.id);
  const errors = validateCues(cues);
  if (errors.length) {
    throw new HttpError(422, '校验未通过，无法发布', { errors });
  }
  withTx(() => {
    db.prepare("UPDATE versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(version.id);
  });
  return { version: getVersion(version.id) };
});

/* ---- 演出 ---- */

route('POST', '/api/shows/:id/performances', (body, p) => {
  const show = getShow(p.id);
  let version;
  if (body.version_id != null) {
    version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?').get(body.version_id, show.id);
    if (!version) throw new HttpError(404, '版本不存在');
    if (version.status !== 'published') {
      throw new HttpError(400, `版本 v${version.version_number} 尚未发布，不能用于启动演出`);
    }
  } else {
    version = db.prepare(
      "SELECT * FROM versions WHERE show_id = ? AND status = 'published' ORDER BY version_number DESC LIMIT 1"
    ).get(show.id);
    if (!version) throw new HttpError(400, '无已发布版本，请先发布执行单后再启动演出');
  }
  const name = String(body.name || '').trim().slice(0, 100);
  const operator = String(body.operator || '').trim().slice(0, 50);
  const info = db.prepare('INSERT INTO performances (show_id, version_id, name, started_by) VALUES (?,?,?,?)')
    .run(show.id, version.id, name, operator);
  return { performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/performances/:id', (body, p) => {
  const perf = db.prepare(`
    SELECT p.*, s.name AS show_name, v.version_number,
      p2.name AS continued_from_name, v2.version_number AS continued_from_version_number,
      p3.id AS continued_to_id, p3.name AS continued_to_name, v3.version_number AS continued_to_version_number
    FROM performances p
    JOIN shows s ON s.id = p.show_id
    JOIN versions v ON v.id = p.version_id
    LEFT JOIN performances p2 ON p2.id = p.continued_from_performance_id
    LEFT JOIN versions v2 ON v2.id = p2.version_id
    LEFT JOIN performances p3 ON p3.continued_from_performance_id = p.id
    LEFT JOIN versions v3 ON v3.id = p3.version_id
    WHERE p.id = ?
  `).get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');

  // 接续关系（供执行台展示）：从何版本何演出承接；已接续时指向接续演出
  const continuation = {
    from: perf.continued_from_performance_id
      ? {
          performance_id: perf.continued_from_performance_id,
          name: perf.continued_from_name,
          version_number: perf.continued_from_version_number,
        }
      : null,
    to: perf.continued_to_id
      ? {
          performance_id: perf.continued_to_id,
          name: perf.continued_to_name,
          version_number: perf.continued_to_version_number,
        }
      : null,
    readonly: perf.status === 'readonly',
  };

  // 可作为接续目标的版本：同场次、版本号更高、已发布（仅可操作演出列出）
  const targets = perf.status === 'active'
    ? db.prepare(`
        SELECT v.id, v.version_number, v.note, v.published_at FROM versions v
        WHERE v.show_id = ? AND v.status = 'published' AND v.version_number > ?
        ORDER BY v.version_number
      `).all(perf.show_id, perf.version_number)
    : [];

  const cues = getVersionCues(perf.version_id);
  // 完整流水（含撤回、承接），按时间升序；返回时倒序（最新在上）
  const events = db.prepare(`
    SELECT e.*, c.label, c.seq FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id
  `).all(perf.id);

  // 归约当前有效结果：fired/skipped 生效，retracted 清除该提示的有效结果
  const eventByCue = new Map();
  for (const e of events) {
    if (e.action === 'retracted') eventByCue.delete(e.cue_id);
    else eventByCue.set(e.cue_id, e);
  }
  const firedLabels = new Set();
  for (const e of eventByCue.values()) {
    if (e.action === 'fired') firedLabels.add(e.label);
  }

  const cueStates = cues.map((c) => {
    const event = eventByCue.get(c.id) || null;
    let status;
    let unmet = [];
    if (event) {
      status = event.action; // fired / skipped
    } else {
      // 未执行提示一律按新版依赖计算状态（承接的已触发会进入 firedLabels，满足前置）
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = unmet.length ? 'blocked' : 'pending';
    }
    return { ...c, status, unmet, event };
  });

  // 双人复核申请流水（最新在上）；待复核申请同时挂到对应提示上，便于执行台禁用操作
  const reviewRequests = db.prepare(`
    SELECT r.*, c.label, c.seq FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id DESC
  `).all(perf.id);
  const pendingByCue = new Map();
  for (const r of reviewRequests) {
    if (r.status === 'pending' && !pendingByCue.has(r.cue_id)) pendingByCue.set(r.cue_id, r);
  }
  for (const c of cueStates) c.pending_request = pendingByCue.get(c.id) || null;

  return {
    performance: perf,
    continuation,
    continue_targets: targets,
    cues: cueStates,
    events: events.slice().reverse(),
    review_requests: reviewRequests,
  };
});

/* ---- 触发 / 跳过 / 撤回（并发安全：BEGIN IMMEDIATE 事务内读最新事件再判定写入） ---- */

function recordEvent(performanceId, cueId, action, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 待复核申请处理前，该提示禁止跳过（fire 对需复核提示已在路由层转为登记申请，不会走到这里）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能${action === 'skipped' ? '跳过' : '触发'}`,
        { request: pending }
      );
    }

    if (action === 'fired') {
      const deps = JSON.parse(cue.deps);
      if (deps.length) {
        // 前置是否满足以"当前有效结果为已触发"判定（已撤回的前置不算）
        const fired = firedLabelSet(perf.version_id, latestByCue);
        const unmet = deps.filter((d) => !fired.has(d));
        if (unmet.length) {
          throw new HttpError(422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
        }
      }
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, action, operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/**
 * 撤回误触发：仅当前有效结果为"已触发"可撤回；已跳过 / 未触发（含已撤回）拒绝。
 * 若沿前置关系可达的后续提示仍有有效"已触发"，整体拒绝并列出受影响编号，任何记录都不改变。
 * 成功后写入 retracted 流水（原触发记录保留），提示回到 待执行 / 受阻，可再次触发或跳过。
 */
function retractEvent(performanceId, cueId, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    // 待复核申请处理前禁止撤回（此时提示本就无有效结果，这里给出更明确的错误）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能撤回`,
        { request: pending }
      );
    }

    const latestByCue = latestEventsByCue(performanceId);
    const latest = latestByCue.get(cueId) || null;
    const current = effectiveAction(latest);
    if (current === 'skipped') {
      throw new HttpError(
        409,
        `该提示当前结果为已跳过，不能撤回（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
        { current: latest }
      );
    }
    if (current !== 'fired') {
      throw new HttpError(409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
    }

    // 反向 BFS：沿前置关系找出所有下游提示，其中仍有效"已触发"的即为受影响项
    const cues = getVersionCues(perf.version_id);
    const childrenOf = new Map();
    for (const c of cues) {
      for (const dep of c.deps) {
        if (!childrenOf.has(dep)) childrenOf.set(dep, []);
        childrenOf.get(dep).push(c);
      }
    }
    const affected = [];
    const visited = new Set([cue.label]);
    const queue = [cue.label];
    while (queue.length) {
      const curLabel = queue.shift();
      for (const child of childrenOf.get(curLabel) || []) {
        if (visited.has(child.label)) continue;
        visited.add(child.label);
        queue.push(child.label);
        const e = latestByCue.get(child.id);
        if (e && e.action === 'fired') affected.push(child.label);
      }
    }
    if (affected.length) {
      throw new HttpError(
        409,
        `无法撤回：以下后续提示仍处于已触发状态，请先撤回：${affected.join('、')}`,
        { affected }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, 'retracted', operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/* ---- 双人复核：触发申请 / 确认 / 撤销 / 驳回 ---- */

/**
 * 登记触发申请：仅登记申请人与时间，提示不算已触发、下游前置仍受阻。
 * 重复申请（已有待复核）或提示已有结果时 409。前置是否满足在确认时才判定，申请阶段不限制。
 */
function createReviewRequest(performanceId, cueId, operator) {
  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    const existing = pendingRequestFor(performanceId, cueId);
    if (existing) {
      throw new HttpError(
        409,
        `该提示已存在待复核的触发申请（申请人 ${existing.requested_by}，时间 ${existing.requested_at}），请勿重复申请`,
        { request: existing }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_review_requests (performance_id, cue_id, requested_by) VALUES (?,?,?)'
    ).run(performanceId, cueId, operator);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/** 取申请并校验属于该演出；只读（已接续）演出拒绝复核处置 */
function getReviewRequest(performanceId, requestId) {
  const req = db.prepare(
    'SELECT * FROM cue_review_requests WHERE id = ? AND performance_id = ?'
  ).get(requestId, performanceId);
  if (!req) throw new HttpError(404, '复核申请不存在');
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (perf) assertActiveInTx(perf);
  return req;
}

function requestConflict(req) {
  return new HttpError(
    409,
    `该申请已处置：${REQUEST_STATUS_TEXT[req.status]}（处置人 ${req.resolved_by || '-'}，时间 ${req.resolved_at || '-'}）`,
    { request: req }
  );
}

/**
 * 确认申请：须为申请人之外的另一操作人；且前置当前均已触发，否则 422 且申请保持待复核。
 * 确认与撤销/驳回在同一事务内判定，并发只有一种结局。确认后写入有效 fired 流水并关联申请。
 */
function confirmReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '复核确认人不能与申请人相同，须由另一操作人确认', { request: req });
    }

    const { perf, cue } = getPerfCue(performanceId, req.cue_id);
    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(req.cue_id) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 前置失效（未触发或已撤回）时拒绝确认，申请保持待复核
    const deps = JSON.parse(cue.deps);
    if (deps.length) {
      const fired = firedLabelSet(perf.version_id, latestByCue);
      const unmet = deps.filter((d) => !fired.has(d));
      if (unmet.length) {
        throw new HttpError(422, `前置提示未触发，无法确认：${unmet.join('、')}`, { unmet, request: req });
      }
    }

    const evInfo = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, req.cue_id, 'fired', operator, `双人复核确认（申请人：${req.requested_by}）`);
    const eventId = Number(evInfo.lastInsertRowid);
    db.prepare(
      "UPDATE cue_review_requests SET status = 'confirmed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), event_id = ? WHERE id = ?"
    ).run(operator, eventId, req.id);
    return {
      request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id),
      event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(eventId),
    };
  });
}

/** 撤销申请：仅申请人本人可撤销待复核申请 */
function cancelReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by !== operator) {
      throw new HttpError(409, `只能由申请人本人（${req.requested_by}）撤销该申请`, { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'cancelled', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(operator, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

/** 驳回申请：申请人之外的其他人填写原因驳回 */
function rejectReviewRequest(performanceId, requestId, operator, reason) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '申请人请使用撤销；驳回须由其他操作人执行', { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolve_reason = ? WHERE id = ?"
    ).run(operator, reason, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/fire', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  // 需双人复核的提示：触发接口转为登记复核申请，不能绕过复核直接写入触发流水；
  // 普通提示保持原有行为与响应（{ event }）
  const { cue } = getPerfCue(perfId, cueId);
  if (cue.needs_review) return createReviewRequest(perfId, cueId, operator);
  return recordEvent(perfId, cueId, 'fired', operator, null);
});

route('POST', '/api/performances/:id/cues/:cueId/review-requests', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  const { cue } = getPerfCue(perfId, cueId);
  if (!cue.needs_review) {
    throw new HttpError(400, `提示「${cue.label}」未标记需双人复核，可直接触发`);
  }
  return createReviewRequest(perfId, cueId, operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/confirm', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return confirmReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/cancel', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return cancelReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/reject', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '驳回必须填写原因');
  return rejectReviewRequest(Number(p.id), Number(p.reqId), operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/skip', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '跳过必须填写原因');
  return recordEvent(Number(p.id), Number(p.cueId), 'skipped', operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/retract', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '撤回必须填写原因');
  return retractEvent(Number(p.id), Number(p.cueId), operator, reason);
});

/* ---- 修订执行单接续（核对 + 执行；与现场操作同一 BEGIN IMMEDIATE 串行判定） ---- */

/**
 * 沿 continued_from_performance_id 回溯整条接续链（含当前演出）。
 * 越靠后的元素越早：[当前演出, 来源演出, 来源的来源演出, ...]。
 */
function continuationChain(performanceId) {
  const chain = [];
  const seen = new Set();
  let cur = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    if (!cur.continued_from_performance_id) break;
    cur = db.prepare('SELECT * FROM performances WHERE id = ?').get(cur.continued_from_performance_id);
  }
  return chain;
}

/**
 * 按编号汇总整条接续链中"有任意痕迹"的提示：触发/跳过/撤回流水、复核申请、承接结果。
 * 返回 Map<label, { label, flags:Set, records:[{...}], pending:[request...] }>。
 */
function collectChainHints(chain) {
  const hints = new Map();
  const ensure = (label) => {
    if (!hints.has(label)) hints.set(label, { label, flags: new Set(), records: [], pending: [] });
    return hints.get(label);
  };
  for (const perf of chain) {
    const eventRows = db.prepare(`
      SELECT e.*, c.label AS label FROM cue_events e
      JOIN cues c ON c.id = e.cue_id
      WHERE e.performance_id = ? ORDER BY e.id
    `).all(perf.id);
    for (const e of eventRows) {
      const h = ensure(e.label);
      // 承接事件同时标出「承接」与其结果类型（触发/跳过），便于核对时辨认
      h.flags.add(e.action);
      if (e.source === 'carried') h.flags.add('carried');
      h.records.push({
        performance_id: perf.id,
        version_number: perf.versionNumberForHints,
        action: e.action,
        source: e.source,
        operator: e.operator,
        created_at: e.created_at,
        reason: e.reason || null,
        carried_from_performance_id: e.carried_from_performance_id || null,
      });
    }
    const reqRows = db.prepare(`
      SELECT r.*, c.label AS label FROM cue_review_requests r
      JOIN cues c ON c.id = r.cue_id
      WHERE r.performance_id = ? ORDER BY r.id
    `).all(perf.id);
    for (const r of reqRows) {
      const h = ensure(r.label);
      h.flags.add('review');
      h.records.push({
        performance_id: perf.id,
        version_number: perf.versionNumberForHints,
        review_request: {
          id: r.id,
          status: r.status,
          requested_by: r.requested_by,
          requested_at: r.requested_at,
          resolved_by: r.resolved_by || null,
          resolve_reason: r.resolve_reason || null,
        },
      });
      if (r.status === 'pending') h.pending.push({ ...r, performance_id: perf.id });
    }
  }
  return hints;
}

/** 接续目标版本校验：同场次、已发布、版本号更高 */
function resolveContinueTarget(perf, targetVersionIdRaw) {
  const targetVersionId = Number(targetVersionIdRaw);
  if (!Number.isInteger(targetVersionId)) throw new HttpError(400, '请指定目标版本（version_id）');
  const target = db.prepare('SELECT * FROM versions WHERE id = ?').get(targetVersionId);
  if (!target) throw new HttpError(404, '目标版本不存在');
  if (target.show_id !== perf.show_id) throw new HttpError(400, '目标版本不属于该场次，不能接续');
  if (target.status !== 'published') {
    throw new HttpError(400, `目标版本 v${target.version_number} 尚未发布，不能用于接续`);
  }
  const current = db.prepare('SELECT * FROM versions WHERE id = ?').get(perf.version_id);
  if (target.version_number <= current.version_number) {
    throw new HttpError(
      400,
      `目标版本须为同场次更高版本：当前 v${current.version_number}，目标 v${target.version_number}`
    );
  }
  return target;
}

/**
 * 接续核对（纯读，不改任何数据）：
 *  - 汇总整条接续链中每个有痕迹编号的标记（触发/跳过/撤回/复核/承接）；
 *  - 新版须保留这些编号，且类型、描述、前置编号集合、复核标记完全一致，否则记为冲突；
 *  - 存在待处理（pending）复核申请则冲突（先去处置：确认/撤销/驳回）。
 * 返回 { can_continue, conflicts, pending_requests, hints, carried, target }。
 */
function buildContinuationPlan(perf, target) {
  const chain = continuationChain(perf.id).map((p) => {
    const v = db.prepare('SELECT version_number FROM versions WHERE id = ?').get(p.version_id);
    return { ...p, versionNumberForHints: v ? v.version_number : null };
  });
  const hints = collectChainHints(chain);

  const targetCues = getVersionCues(target.id);
  const targetByLabel = new Map(targetCues.map((c) => [c.label, c]));
  // 当前演出版本中各编号的内容（冲突核对以"当前可操作演出的版本"为准）
  const currentByLabel = new Map(getVersionCues(perf.version_id).map((c) => [c.label, c]));

  const conflictsMap = new Map();
  const addConflict = (label, reason) => {
    if (!conflictsMap.has(label)) conflictsMap.set(label, []);
    const arr = conflictsMap.get(label);
    if (!arr.includes(reason)) arr.push(reason);
  };

  for (const label of hints.keys()) {
    const tc = targetByLabel.get(label);
    if (!tc) {
      addConflict(label, '新版缺失该编号（修订执行单须保留有流水或复核申请的提示编号）');
      continue;
    }
    const cur = currentByLabel.get(label);
    // 编号在更早版本出现、当前版本已不存在：本身就已不可接续，同样按缺失核对
    if (!cur) {
      addConflict(label, '当前演出版本已无该编号，无法核对承接内容');
      continue;
    }
    if (tc.type !== cur.type) addConflict(label, `类型不一致：v${target.version_number} 为 ${tc.type}，当前为 ${cur.type}`);
    if (tc.description !== cur.description) addConflict(label, '描述被修改（有记录的提示描述须原样保留）');
    const curDeps = new Set(cur.deps);
    const newDeps = new Set(tc.deps);
    const missingDeps = cur.deps.filter((d) => !newDeps.has(d));
    const addedDeps = tc.deps.filter((d) => !curDeps.has(d));
    if (missingDeps.length || addedDeps.length) {
      const parts = [];
      if (missingDeps.length) parts.push(`缺少前置：${missingDeps.join('、')}`);
      if (addedDeps.length) parts.push(`新增前置：${addedDeps.join('、')}`);
      addConflict(label, `前置编号集合不一致（${parts.join('；')}）`);
    }
    if (Boolean(tc.needs_review) !== Boolean(cur.needs_review)) {
      addConflict(label, `复核标记不一致：v${target.version_number} 为${tc.needs_review ? '需复核' : '无需复核'}，当前为${cur.needs_review ? '需复核' : '无需复核'}`);
    }
  }

  // 待处理复核申请：链上（防御性）与当前演出的 pending 申请全部列出并构成冲突
  const pendingRequests = [];
  for (const h of hints.values()) {
    for (const rq of h.pending) {
      pendingRequests.push({
        label: h.label,
        request_id: rq.id,
        requested_by: rq.requested_by,
        requested_at: rq.requested_at,
        performance_id: rq.performance_id,
      });
      addConflict(h.label, '存在待处理的复核申请，接续前须先确认、撤销或驳回');
    }
  }

  // 承接清单：当前演出的有效结果（fired/skipped；retracted=无有效结果，不承接）
  const latestByCue = latestEventsByCue(perf.id);
  const carried = [];
  for (const cue of targetCues) {
    const cur = currentByLabel.get(cue.label);
    if (!cur) continue;
    const e = latestByCue.get(cur.id);
    if (e && e.action !== 'retracted') {
      carried.push({
        label: cue.label,
        action: e.action,
        operator: e.operator,
        created_at: e.created_at,
        source_event_id: e.id,
        target_cue_id: cue.id,
      });
    }
  }

  const hintList = [...hints.values()]
    .map((h) => ({
      label: h.label,
      flags: [...h.flags],
      flag_text: h.flags.size ? [...h.flags].map((f) => HINT_FLAG_TEXT[f] || f).join('、') : '',
      records: h.records.map((r) => {
        if (r.review_request) {
          return {
            kind: 'review',
            performance_id: r.performance_id,
            version_number: r.version_number,
            status: r.review_request.status,
            operator: r.review_request.requested_by,
            time: r.review_request.requested_at,
            reason: r.review_request.resolve_reason,
          };
        }
        return {
          kind: r.action,
          performance_id: r.performance_id,
          version_number: r.version_number,
          source: r.source,
          operator: r.operator,
          time: r.created_at,
          reason: r.reason,
          carried_from_performance_id: r.carried_from_performance_id,
        };
      }),
    }))
    .sort((a, b) => {
      const ia = targetByLabel.has(a.label) ? targetByLabel.get(a.label).seq : Number.MAX_SAFE_INTEGER;
      const ib = targetByLabel.has(b.label) ? targetByLabel.get(b.label).seq : Number.MAX_SAFE_INTEGER;
      return ia - ib || a.label.localeCompare(b.label);
    });

  const conflicts = [...conflictsMap.entries()]
    .map(([label, reasons]) => ({ label, reasons }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    can_continue: conflicts.length === 0,
    conflicts,
    pending_requests: pendingRequests.sort((a, b) => a.label.localeCompare(b.label)),
    hints: hintList,
    carried,
  };
}

route('POST', '/api/performances/:id/continue/preview', (body, p) => {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');
  if (perf.status === 'readonly') {
    throw new HttpError(409, '该演出已接续并转为只读，不能再发起接续；请从当前可操作（接续）演出发起', { readonly: true });
  }
  const target = resolveContinueTarget(perf, body.version_id);
  const plan = buildContinuationPlan(perf, target);
  return {
    performance: { id: perf.id, name: perf.name },
    target_version: { id: target.id, version_number: target.version_number, note: target.note },
    ...plan,
  };
});

/**
 * 执行接续：
 *  事务内再次核对（与触发/跳过/撤回/复核串行），有冲突整体放弃，原演出保持可操作、不产生接续记录；
 *  通过则新建接续演出（绑定目标版本），把当前演出有效结果复制为 carried 流水（保留原操作人与时间，
 *  非再次触发、标出来源），并将原演出置为 readonly（仍绑定原快照，仅可回看）。
 */
function continuePerformance(perf, target, operator, name) {
  return withTx(() => {
    // 事务内读最新状态：可能在排队期间已被接续 / 被现场操作改动
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perf.id);
    assertActiveInTx(fresh);

    const plan = buildContinuationPlan(fresh, target);
    if (plan.conflicts.length) {
      throw new HttpError(409, '接续核对未通过，请按冲突清单处理后重试', {
        conflicts: plan.conflicts,
        pending_requests: plan.pending_requests,
      });
    }

    const perfName = name
      || `${fresh.name || '演出'}（接续 v${target.version_number}）`;
    const info = db.prepare(`
      INSERT INTO performances (show_id, version_id, name, started_by, status,
                                continued_from_performance_id, continued_at, continued_by)
      VALUES (?,?,?,?,'active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)
    `).run(fresh.show_id, target.id, perfName.slice(0, 100), operator, fresh.id, operator);
    const newId = Number(info.lastInsertRowid);

    // 承接有效结果：复制为 carried 流水，沿用原操作人与原时间，指向来源事件/来源演出；
    // action 仍为 fired/skipped，故状态归约与前置判定复用现有逻辑（绝非再次触发）
    const ins = db.prepare(`
      INSERT INTO cue_events (performance_id, cue_id, action, operator, reason, created_at,
                              source, carried_from_performance_id, carried_from_event_id)
      VALUES (?,?,?,?,?,?, 'carried', ?, ?)
    `);
    for (const item of plan.carried) {
      ins.run(newId, item.target_cue_id, item.action, item.operator,
        `自演出 #${fresh.id} 承接（${ACTION_TEXT[item.action]}）`,
        item.created_at, fresh.id, item.source_event_id);
    }

    // 原演出转只读：仍绑定原版本快照，流水与申请全部保留；记录接续时间与操作人
    db.prepare(`
      UPDATE performances SET status = 'readonly',
        continued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), continued_by = ?
      WHERE id = ?
    `).run(operator, fresh.id);

    const newPerf = db.prepare('SELECT * FROM performances WHERE id = ?').get(newId);
    return {
      performance: newPerf,
      source_performance_id: fresh.id,
      target_version: { id: target.id, version_number: target.version_number, note: target.note },
      carried_count: plan.carried.length,
      carried: plan.carried.map((c) => ({ label: c.label, action: c.action, operator: c.operator })),
    };
  });
}

route('POST', '/api/performances/:id/continue', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');
  if (perf.status === 'readonly') {
    throw new HttpError(409, '该演出已接续并转为只读，不能重复接续；请从当前可操作（接续）演出发起', { readonly: true });
  }
  const target = resolveContinueTarget(perf, body.version_id);
  const name = String(body.name || '').trim().slice(0, 100);
  return continuePerformance(perf, target, operator, name);
});

/* ---- 现场成组处置（逐项预览 + 整组提交；与单项 / 接续同一 BEGIN IMMEDIATE 串行判定） ---- */

const BATCH_ACTIONS = ['fire', 'skip', 'retract'];
const BATCH_ACTION_TEXT = { fire: '触发', skip: '跳过', retract: '撤回' };
const BATCH_MAX_ITEMS = 500;

/**
 * 解析成组请求体并做整组结构校验：本组操作人必填；items 为非空数组（≤500）；
 * 每项编号非空、动作合法；编号不得重复。任一不满足直接拒绝（不进入逐项判定）。
 */
function parseGroupBody(body) {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写本组操作人');
  if (!Array.isArray(body.items)) throw new HttpError(400, '请求格式错误：items 应为数组');
  if (body.items.length === 0) throw new HttpError(400, '成组操作清单为空：请至少添加一项');
  if (body.items.length > BATCH_MAX_ITEMS) throw new HttpError(400, `成组操作项过多（上限 ${BATCH_MAX_ITEMS} 项）`);

  const items = body.items.map((raw, i) => {
    const label = String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50);
    const action = String((raw && raw.action) || '').trim();
    const reason = String((raw && raw.reason) != null ? raw.reason : '').trim().slice(0, 200);
    if (!label) throw new HttpError(400, `第 ${i + 1} 项：提示编号不能为空`);
    if (!BATCH_ACTIONS.includes(action)) {
      throw new HttpError(400, `第 ${i + 1} 项（编号 ${label}）：动作无效，应为 fire / skip / retract`);
    }
    return { label, action, reason };
  });

  const seen = new Set();
  items.forEach((it, i) => {
    if (seen.has(it.label)) {
      throw new HttpError(400, `第 ${i + 1} 项：编号「${it.label}」在本组清单中重复，每个编号只能出现一次`);
    }
    seen.add(it.label);
  });

  return { operator, items };
}

/**
 * 逐项判定成组处置（核心规则与单项接口完全一致）：
 *  - 按清单顺序逐项处理，每一步基于前序步骤产生的有效结果判定（前置满足、下游保护、待复核限制）；
 *  - 任一项失败只记录该项失败原因，不影响后续项的预览判定（dryRun 时失败项不产生有效结果）；
 *  - dryRun=true（预览）：不写任何数据，成功项以拟操作参与后续判定；
 *  - dryRun=false（提交）：调用方须已持有 BEGIN IMMEDIATE 事务并确认演出可操作；成功项立即写入
 *    与单项一致的 manual 流水，任一项失败由调用方整体回滚（整组不产生流水）。
 * 返回 { results, success_count, failure_count, can_submit }。
 */
function evaluateBatch(perf, operator, items, dryRun) {
  const versionId = perf.version_id;
  const cues = getVersionCues(versionId);
  const byLabel = new Map(cues.map((c) => [c.label, c]));

  // 可变状态：初始为演出当前有效结果，前序成功项实时改写（同一内存快照内串行判定）
  const latestByCue = latestEventsByCue(perf.id);
  const firedLabels = new Set();
  for (const c of cues) {
    const e = latestByCue.get(c.id);
    if (e && e.action === 'fired') firedLabels.add(c.label);
  }

  const pendingRows = db.prepare(
    "SELECT * FROM cue_review_requests WHERE performance_id = ? AND status = 'pending' ORDER BY id"
  ).all(perf.id);
  const pendingByCue = new Map(pendingRows.map((r) => [r.cue_id, r]));

  // 前置关系反向索引（撤回时的下游保护）
  const childrenOf = new Map();
  for (const c of cues) {
    for (const dep of c.deps) {
      if (!childrenOf.has(dep)) childrenOf.set(dep, []);
      childrenOf.get(dep).push(c);
    }
  }

  const insertEvent = db.prepare(
    'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
  );
  const getEvent = (id) => db.prepare('SELECT * FROM cue_events WHERE id = ?').get(id);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  function recordFailure(item, i, cue, status, message, extra) {
    failureCount += 1;
    results.push({
      index: i + 1,
      seq: cue ? cue.seq : null,
      cue_id: cue ? cue.id : null,
      label: item.label,
      action: item.action,
      ok: false,
      status,
      error: message,
      ...(extra || {}),
    });
  }

  function recordSuccess(item, i, cue, action, reason) {
    let event;
    if (dryRun) {
      // 预览：以拟操作更新内存状态供后续项判定，不写库
      event = {
        id: null, performance_id: perf.id, cue_id: cue.id, action,
        operator, reason, created_at: null, source: 'manual',
      };
    } else {
      const info = insertEvent.run(perf.id, cue.id, action, operator, reason);
      event = getEvent(Number(info.lastInsertRowid));
    }
    latestByCue.set(cue.id, event);
    if (action === 'fired') firedLabels.add(cue.label);
    if (action === 'retracted') firedLabels.delete(cue.label);
    successCount += 1;
    results.push({
      index: i + 1,
      seq: cue.seq,
      cue_id: cue.id,
      label: cue.label,
      action: item.action,
      ok: true,
      operator,
      reason,
      planned: dryRun,
      event: dryRun ? null : event,
    });
  }

  items.forEach((item, i) => {
    const cue = byLabel.get(item.label);
    if (!cue) {
      recordFailure(item, i, null, 404, `提示编号「${item.label}」不存在于当前演出版本`);
      return;
    }

    const pending = pendingByCue.get(cue.id) || null;
    const latest = latestByCue.get(cue.id) || null;
    const effective = effectiveAction(latest);

    if (item.action === 'fire') {
      // 与单项 fire 相同的状态判定；需双人复核提示禁止成组直接触发（不能绕过申请—确认）
      if (effective) {
        recordFailure(
          item, i, cue, 409,
          `该提示已有结果：${ACTION_TEXT[effective]}（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
          { current: latest }
        );
        return;
      }
      if (pending) {
        recordFailure(
          item, i, cue, 409,
          `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能触发`,
          { request: pending }
        );
        return;
      }
      if (cue.needs_review) {
        recordFailure(item, i, cue, 409, '该提示需双人复核，不能在成组操作中直接触发；请先在执行台发起触发申请，并由另一操作人确认');
        return;
      }
      const unmet = cue.deps.filter((d) => !firedLabels.has(d));
      if (unmet.length) {
        recordFailure(item, i, cue, 422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
        return;
      }
      recordSuccess(item, i, cue, 'fired', null);
      return;
    }

    if (item.action === 'skip') {
      if (effective) {
        recordFailure(
          item, i, cue, 409,
          `该提示已有结果：${ACTION_TEXT[effective]}（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
          { current: latest }
        );
        return;
      }
      if (pending) {
        recordFailure(
          item, i, cue, 409,
          `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能跳过`,
          { request: pending }
        );
        return;
      }
      if (!item.reason) {
        recordFailure(item, i, cue, 400, '跳过必须填写原因');
        return;
      }
      recordSuccess(item, i, cue, 'skipped', item.reason);
      return;
    }

    // retract：与单项撤回一致（待复核拒绝 / 已跳过或未触发拒绝 / 缺原因 / 下游仍已触发整体拒绝）
    if (pending) {
      recordFailure(
        item, i, cue, 409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能撤回`,
        { request: pending }
      );
      return;
    }
    if (effective === 'skipped') {
      recordFailure(
        item, i, cue, 409,
        `该提示当前结果为已跳过，不能撤回（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
        { current: latest }
      );
      return;
    }
    if (effective !== 'fired') {
      recordFailure(item, i, cue, 409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
      return;
    }
    if (!item.reason) {
      recordFailure(item, i, cue, 400, '撤回必须填写原因');
      return;
    }
    // 反向 BFS：前序步骤刚撤回的下游已从 firedLabels 移除，判定随之级联
    const affected = [];
    const visited = new Set([cue.label]);
    const queue = [cue.label];
    while (queue.length) {
      const curLabel = queue.shift();
      for (const child of childrenOf.get(curLabel) || []) {
        if (visited.has(child.label)) continue;
        visited.add(child.label);
        queue.push(child.label);
        if (firedLabels.has(child.label)) affected.push(child.label);
      }
    }
    if (affected.length) {
      recordFailure(
        item, i, cue, 409,
        `无法撤回：以下后续提示仍处于已触发状态，请先撤回：${affected.join('、')}`,
        { affected }
      );
      return;
    }
    recordSuccess(item, i, cue, 'retracted', item.reason);
  });

  return {
    results,
    success_count: successCount,
    failure_count: failureCount,
    can_submit: failureCount === 0,
  };
}

/** 取演出并拒绝只读（已接续）演出：成组预览与提交均不允许在只读演出上进行 */
function getActivePerformance(performanceId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  assertActiveInTx(perf);
  return perf;
}

route('POST', '/api/performances/:id/batch/preview', (body, p) => {
  const { operator, items } = parseGroupBody(body);
  const perf = getActivePerformance(Number(p.id));
  // Node 单线程同步读：快照内逐项判定，不会穿插其他写操作；不修改任何数据
  const plan = evaluateBatch(perf, operator, items, true);
  const version = db.prepare('SELECT id, version_number FROM versions WHERE id = ?').get(perf.version_id);
  return {
    performance: { id: perf.id, name: perf.name },
    version,
    operator,
    ...plan,
  };
});

route('POST', '/api/performances/:id/batch', (body, p) => {
  const { operator, items } = parseGroupBody(body);
  const perfId = Number(p.id);
  return withTx(() => {
    // 提交瞬间在 BEGIN IMMEDIATE 内重读最新状态并重新逐项判定：
    // 与单项操作、接续串行，排队期间的任何现场变化都会纳入判定，不信任此前预览结果
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
    if (!fresh) throw new HttpError(404, '演出不存在');
    assertActiveInTx(fresh);

    const plan = evaluateBatch(fresh, operator, items, false);
    if (plan.failure_count > 0) {
      // 任一项失败：事务回滚，整组不产生任何流水（含此前各项的拟写入）。
      // 清洗成功项上的拟写入事件（其 id 随回滚失效），统一标记为未生效，避免误以为已落库。
      const rolledBackResults = plan.results.map((r) => r.ok
        ? { ...r, event: null, rolled_back: true }
        : r);
      const overallStatus = rolledBackResults.some((r) => !r.ok && r.status === 422)
        ? 422
        : rolledBackResults.some((r) => !r.ok && r.status === 400)
          ? 400
          : 409;
      const first = rolledBackResults.find((r) => !r.ok);
      throw new HttpError(
        overallStatus,
        `成组操作未执行：第 ${first.index} 项（编号 ${first.label}）${first.error}。整组均未生效、无流水产生，请调整后重新提交`,
        {
          results: rolledBackResults,
          success_count: 0,
          failure_count: plan.failure_count,
        }
      );
    }
    return {
      performance: { id: fresh.id, name: fresh.name },
      submitted: true,
      success_count: plan.success_count,
      failure_count: 0,
      results: plan.results,
    };
  });
});

/* ---------------- 分发 ---------------- */

async function handle(req, res, url, body) {
  const pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const result = await r.handler(body, params, req);
    return { status: 200, data: result };
  }
  throw new HttpError(404, '接口不存在');
}

module.exports = { handle, HttpError };
