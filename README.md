# 舞台监督提示单系统（Stage Cue Manager）

供舞台监督在**排演**与**现场执行**中使用的 Web 应用：录入场次与执行单（灯光 / 音效 / 布景提示及其前置提示），校验后发布不可变执行单；每场演出从某一已发布版本启动独立记录，现场按依赖关系触发或跳过提示，全程留痕。

## 功能

- **场次与执行单管理**：按序编排提示（编号、类型、描述、前置提示）
- **发布前校验**：缺失引用（前置编号不存在）、编号重复、自依赖、循环依赖（给出环路径）
- **不可变执行单**：发布后内容锁定；修改须新建草稿再发布新版本
- **现场执行台**：实时展示 待执行 / 已触发 / 已跳过 / 受阻（前置未触发） 四种状态
  - 仅当前置全部**已触发**时才可触发；受阻项触发按钮禁用且服务端同样拒绝
  - 跳过必须填写原因；每次结果留存操作人与时间
  - **双人复核触发**：草稿中可将个别提示标记为「需双人复核」（发布后随版本锁定，旧版本提示按无需复核处理）。现场对这类提示发起的是**触发申请**（记录申请人与时间），提示仍不算已触发、下游前置仍受阻；须**另一操作人确认**且前置当前均已触发后，才写入有效触发流水。申请人可撤销待处理申请，其他人可填原因驳回，申请与处置全程留痕；待处理期间拒绝跳过、重复申请和撤回
  - **撤回误触发**：对当前「已触发」的提示可撤回（须填撤回人与原因）；若其下游（沿前置关系可达的后续提示）仍有有效「已触发」，则整体拒绝并列出受影响编号，任何记录都不改变。撤回后原触发与撤回流水全部保留，提示按当前前置结果回到「待执行 / 受阻」，可再次触发或跳过；已跳过与未触发的提示不可撤回
  - 多人并发操作同一提示只记一次有效结果，冲突方会收到当前状态提示；复核的确认与撤销 / 驳回并发时也只有一种结局
- **版本隔离与回看**：演出锁定启动时的已发布版本；排演改草稿不影响进行中的演出，历史演出始终按当时版本回看
- **改用修订执行单（接续演出）**：现场需改用新版本时，舞台监督指定当前演出、同场次更高且已发布的目标版本与非空操作人，先按编号核对（原演出及其接续来源中有任意触发 / 跳过 / 撤回流水、复核申请或承接结果的编号都会列出并标记），再生成接续演出。原演出仍绑定原快照并转为只读；新版中这些编号的类型、描述、前置编号集合、复核标记均须保留且不存在待处理复核申请，否则按编号返回冲突原因，原演出保持可操作、不产生接续记录。接续演出继承有效结果（标注「承接」及来源演出 / 来源流水，保留原操作人与时间，非再次触发），原流水仍可在原演出查看，未执行提示按新版依赖重算待执行 / 受阻；接续与现场操作串行判定，已只读演出拒绝后续操作，多次接续只能从当前可操作演出发起
- **成组连续处置**：现场需按顺序连续处置多条提示时，舞台监督在当前**可操作演出**中一次性选择不同编号、逐项指定**触发 / 跳过 / 撤回**，填写本组操作人及各项跳过 / 撤回原因；空清单或重复编号直接拒绝。执行台先展示**逐项预览**（每一步基于前面步骤产生的有效结果判定前置满足、下游撤回保护与待复核限制）与失败原因；**需双人复核的提示不得在成组中直接触发**（请走单项申请—确认）。提交瞬间在事务内按最新状态**重新逐项判定**，任一项失败都指出序号、编号与原因且**整组不产生流水**，全部通过才依次留下与单项操作一致的执行流水并返回各项结果；只读演出拒绝预览与提交，成组提交与接续、单项操作在同一事务级串行，现有单项接口与响应保持兼容
- **明确错误**：无已发布版本、非法依赖、前置未满足、缺少操作人 / 原因等均有中文错误提示

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

启动后访问：**http://localhost:3000**

- 首次启动自动初始化数据库（建表），空库时写入一份演示数据（可用 `SEED_DEMO: "0"` 关闭）
- SQLite 数据保存在名为 `cue-data` 的卷中（容器内 `/app/data/app.db`），删除容器不丢数据

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务端口（compose 中映射为 `宿主机:容器`，改宿主机端口请改 `ports`，如 `"8080:3000"`） |
| `DB_PATH` | `/app/data/app.db`（本地运行为 `./data/app.db`） | SQLite 数据库文件路径 |
| `SEED_DEMO` | `1` | 空库时是否写入演示数据，`0` 关闭 |
| `HOST` | `0.0.0.0` | 监听地址 |

## 本地开发（不用 Docker）

要求 Node.js ≥ 22.13（推荐 24，使用内置 `node:sqlite`，**无任何第三方依赖**）：

```bash
npm start          # 或 node server.js
# 打开 http://localhost:3000
```

## 使用流程

1. **新建场次** → 进入场次后「新建草稿」
2. 在草稿编辑器中按序录入提示，前置提示填编号（逗号分隔）；危险或关键提示勾选「复核」列；随时「校验」
3. 「校验并发布」→ 生成不可变执行单（如 v1），复核标记随版本锁定
4. 回到场次页「启动演出」，选择已发布版本 → 进入执行台
5. 执行台中填写操作人，对提示执行「触发 / 跳过」；需复核提示点「申请触发」后在右侧「复核申请」面板由**另一操作人**确认（前置未齐会被拒并保持待复核），申请人可撤销、其他人可填原因驳回；误触发可点「撤回」并填写撤回人与原因；页面每 2.5 秒自动刷新，多人可同时操作；右侧展示复核申请处置记录与完整执行流水（含撤回记录）
   - 需要连续处置多条提示时，用顶部「📋 成组连续处置」：按顺序添加编号与动作（触发 / 跳过 / 撤回）、填写各项原因，先「逐项预览」确认每步前置 / 下游 / 复核判定，再「整组提交」（事务内重判，任一失败整组不留流水；需双人复核的提示不在此触发）
6. 排演中要改执行单：新建草稿（自动复制最新版本，含复核标记）→ 修改 → 发布为 v2；新演出即可选 v2，旧演出仍按 v1 回看
7. **现场需改用新版**：进入当前演出执行台，点「改用修订执行单 → 发起接续」，选择更高的已发布版本、填写操作人，先「按编号核对」查看有痕迹编号（触发 / 跳过 / 撤回 / 复核 / 承接）与冲突，通过后「生成接续演出」。原演出立即只读（顶部横幅可跳到接续演出），接续演出继承有效结果并标注「承接」；需要再次修订时，只能从最新的接续演出发起下一次接续

## 技术栈与结构

- **后端**：Node.js 内置 `node:http`（API + 静态页面），零第三方依赖
- **数据库**：SQLite（Node 内置 `node:sqlite`），关系型 schema，WAL 模式，事务 + 唯一约束保证并发一致
- **前端**：原生 HTML/CSS/JS 单页应用（hash 路由），无需构建

```
server.js            # HTTP 入口：API 分发、静态文件、统一错误处理
src/db.js            # SQLite 连接、建表初始化、事务包装、演示数据
src/validate.js      # 执行单校验：缺失引用 / 重复编号 / 自依赖 / 循环依赖
src/api.js           # 全部 REST 接口与业务规则
public/              # 前端单页应用（index.html / app.js / style.css）
Dockerfile           # node:24-slim，零依赖构建
docker-compose.yml   # 一键启动 + 数据卷
```

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/shows` | 场次列表 / 新建场次 |
| GET | `/api/shows/:id` | 场次详情（版本 + 演出记录） |
| POST | `/api/shows/:id/versions` | 新建草稿（默认复制最新版本） |
| GET | `/api/versions/:id` | 版本快照（含提示与前置） |
| PUT | `/api/versions/:id/cues` | 保存草稿（已发布返回 409） |
| POST | `/api/versions/:id/validate` | 校验（缺失引用 / 循环依赖） |
| POST | `/api/versions/:id/publish` | 发布（校验失败 422 并附问题清单） |
| POST | `/api/shows/:id/performances` | 启动演出（无已发布版本返回 400） |
| GET | `/api/performances/:id` | 执行台状态（提示状态 + 事件流水 + 复核申请；附 `continuation` 接续关系与 `continue_targets` 可接续目标版本；各提示附 `needs_review` 与 `pending_request`；承接流水 `source:"carried"`） |
| POST | `/api/performances/:id/continue/preview` | **接续前按编号核对**（不改数据）：返回有痕迹编号及标记 `hints`、冲突清单 `conflicts`、待处理申请 `pending_requests`、拟承接结果 `carried` 与 `can_continue` |
| POST | `/api/performances/:id/continue` | **生成接续演出**（body：`version_id` 目标版本、`operator` 必填、`name` 可选）。成功返回新演出与承接清单；冲突 409 附编号与原因；只读演出 / 非更高或未发布目标 4xx |
| POST | `/api/performances/:id/batch/preview` | **成组连续处置·逐项预览**（不改数据）：body `{operator, items:[{label,action,reason}]}`，`action` 为 `fire/skip/retract`。返回逐项判定 `results`、成功/失败计数与 `can_submit`；空清单、重复编号、非法动作 400；只读演出 409 |
| POST | `/api/performances/:id/batch` | **成组连续处置·整组提交**：事务内按最新状态重新逐项判定，全部通过才依次写入与单项一致的流水并返回各项结果；任一项失败回滚、**整组不产生流水**，4xx 附逐项 `results`（含序号、编号、原因）；只读演出 409 |
| POST | `/api/performances/:id/cues/:cueId/fire` | 触发（前置未满足 422；已有结果 409 附当前状态；只读演出 409）。**需复核提示调用本接口不会直接触发**，而是登记复核申请并返回 `{ request }`；普通提示响应保持 `{ event }` |
| POST | `/api/performances/:id/cues/:cueId/skip` | 跳过（缺原因 400；已有结果 409；待复核期间 409；只读演出 409） |
| POST | `/api/performances/:id/cues/:cueId/retract` | 撤回已触发（缺撤回人/原因 400；非已触发 409；下游仍已触发 409 附 `affected` 编号列表；待复核期间 409；只读演出 409） |
| POST | `/api/performances/:id/cues/:cueId/review-requests` | 登记触发申请（仅需复核提示可用，普通提示 400；重复申请 409；只读演出 409） |
| POST | `/api/performances/:id/review-requests/:reqId/confirm` | 确认申请（确认人须与申请人不同 409；前置未触发 422 且申请保持待复核；已处置 409；只读演出 409） |
| POST | `/api/performances/:id/review-requests/:reqId/cancel` | 撤销申请（仅申请人本人，否则 409；已处置 409；只读演出 409） |
| POST | `/api/performances/:id/review-requests/:reqId/reject` | 驳回申请（缺原因 400；申请人请走撤销 409；已处置 409；只读演出 409） |

## 撤回误触发（本轮新增）

现场误触发需要可追溯地撤回：不删除任何记录，而是追加一条 `retracted` 流水，使该提示的当前有效结果失效。

**规则**

- 仅当前有效结果为「已触发」的提示可撤回；「已跳过」与「未触发（含已撤回）」返回 409
- 请求必须携带 `operator`（撤回人）与 `reason`（原因），缺一则 400
- 若沿前置关系可达的后续提示仍存在有效「已触发」，撤回整体拒绝（409），响应 `affected` 字段列出受影响提示编号，任何记录都不改变；需自下游向上游逐级撤回
- 撤回成功后：原触发与撤回流水全部保留（执行台右侧完整展示）；该提示按当前前置结果重新显示「待执行」或「受阻」，可再次触发或跳过
- 撤回、触发、跳过在同一有效状态上判定（`BEGIN IMMEDIATE` 事务内读最新事件再写入），至多一个当前有效结果，并发冲突方收到 409 及当前结果
- 仅影响本场演出；已发布版本与其他演出不受影响

**调用示例**（假设演出 id=1，提示 id=3）：

```bash
# 1) 触发（原有能力）
curl -X POST http://localhost:3000/api/performances/1/cues/3/fire \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三"}'
# → 200 {"event":{"id":7,"action":"fired","operator":"张三",...}}

# 2) 发现误触发，撤回
curl -X POST http://localhost:3000/api/performances/1/cues/3/retract \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李四","reason":"误触发，未到cue点"}'
# → 200 {"event":{"id":9,"action":"retracted","operator":"李四","reason":"误触发，未到cue点",...}}

# 3) 若下游仍有已触发提示，撤回被拒并列出受影响编号（任何记录不变）
# → 409 {"error":"无法撤回：以下后续提示仍处于已触发状态，请先撤回：S1、B1","affected":["S1","B1"]}

# 4) 查看完整流水与提示状态（撤回后该提示回到 待执行/受阻，可再次触发或跳过）
curl http://localhost:3000/api/performances/1
# events 中同时保留 fired 与 retracted 记录；cues[].status 为 pending 或 blocked
```

## 双人复核触发（本轮新增）

排演时在草稿编辑器勾选提示的「复核」列（`needs_review`），发布后标记随版本锁定；旧版本提示一律按无需复核处理。现场对这类提示的触发改为**申请—确认**两步：

**规则**

- 对需复核提示调用 `fire`（或 `POST .../review-requests`）只登记**触发申请**：记录申请人与时间，提示**不算已触发**，下游前置仍受阻；普通提示 `fire` 行为与响应（`{ event }`）不变，直接调用既有触发接口无法绕过复核
- **确认**：须由申请人之外的另一操作人执行，且前置当前均已触发才写入有效 `fired` 流水（事件关联申请）；前置失效（未触发或已撤回）时确认返回 422，**申请保持待复核**，前置恢复后可再次确认
- **撤销 / 驳回**：申请人本人可撤销待处理申请；其他人可填原因驳回（申请人驳回返回 409，请走撤销）；申请与处置（处置人、时间、原因）全部留痕
- **待处理期间**：该提示拒绝跳过、重复申请和撤回（均 409）；确认与撤销 / 驳回在事务内串行判定，并发只有一种结局，后到者收到 409 及当前处置结果
- 已确认（已触发）的提示与普通提示一样受现有撤回及下游保护；撤回后可重新申请
- 执行台右侧展示待复核申请（确认 / 驳回 / 撤销按钮）与处置记录，提示卡片上标注「双人复核」与待复核状态

**调用示例**（假设演出 id=1，需复核提示 id=6，申请 id=2）：

```bash
# 1) 申请人发起触发申请（对需复核提示调 fire 自动转为登记申请，不会直接触发）
curl -X POST http://localhost:3000/api/performances/1/cues/6/fire \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三"}'
# → 200 {"request":{"id":2,"status":"pending","requested_by":"张三","requested_at":"...",...}}
#    提示仍未触发，下游前置仍受阻；重复申请 / 跳过 / 撤回该提示均 409

# 2) 另一操作人确认：前置未全部触发时拒绝，申请保持待复核
curl -X POST http://localhost:3000/api/performances/1/review-requests/2/confirm \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李四"}'
# → 422 {"error":"前置提示未触发，无法确认：B1、L2","unmet":["B1","L2"],...}
#    申请人自己确认 → 409「复核确认人不能与申请人相同」

# 3) 前置全部触发后再次确认 → 写入有效触发流水
# → 200 {"request":{"status":"confirmed","event_id":12,...},"event":{"action":"fired","operator":"李四",...}}

# 4) 申请人撤销待处理申请（非申请人撤销 409）
curl -X POST http://localhost:3000/api/performances/1/review-requests/2/cancel \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三"}'

# 5) 其他人填原因驳回（缺原因 400；申请人驳回 409，请走撤销）
curl -X POST http://localhost:3000/api/performances/1/review-requests/2/reject \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李四","reason":"时机不对"}'

# 6) 执行台状态含复核申请流水与每提示的待复核申请
curl http://localhost:3000/api/performances/1
# review_requests：全部申请及处置留痕（最新在上）
# cues[].needs_review / cues[].pending_request：复核标记与当前待复核申请
```

## 现场改用修订执行单（接续演出）（本轮新增）

现场进行中需要改用新发布的修订执行单时，不重开一场空白演出，而是从当前演出**接续**：

1. 舞台监督在执行台「改用修订执行单」面板选择**目标版本**（必须是同场次、版本号更高、已发布）并填写非空**操作人**；
2. 先「按编号核对」：系统沿接续链汇总**原演出及其全部接续来源**中，有任意**触发 / 跳过 / 撤回流水、复核申请（含已处置）或承接结果**的编号；
3. 核对要求：这些编号在新版中必须保留，且**类型、描述、前置编号集合、复核标记**与当前版本完全一致；同时演出上不得有**待处理（pending）复核申请**（先去确认 / 撤销 / 驳回）；
4. 通过后「生成接续演出」：新建演出绑定新版本（可操作），原演出仍绑定原版本快照并立即转为**只读**；
5. 接续演出**继承有效结果**（当前有效 `fired`/`skipped`）：复制为 `source:"carried"` 的流水，保留原操作人与原时间，并记录来源演出与来源事件——**不是再次触发**；已撤回 / 未执行的提示不继承，按新版依赖重新计算「待执行 / 受阻」（承接的已触发同样满足前置）；
6. 原演出的流水、复核申请全部保留可查，执行台顶部以横幅展示「承接自 / 已接续到」关系，提示卡片与流水对承接结果标注「承接」徽章。

**串行与冲突**

- 接续与触发 / 跳过 / 撤回 / 复核处置在同一 `BEGIN IMMEDIATE` 事务内判定：接续提交瞬间仍会再读最新状态并重跑核对，现场操作与接续不可能互相覆盖。
- 冲突时（含事务内才出现的冲突）整体回滚：返回 409 与 `conflicts`（每个编号附原因），**原演出保持可操作，不产生任何接续记录或承接流水**。
- 已转只读的演出拒绝全部现场操作（fire/skip/retract/复核处置/再次接续），统一 409 并在响应中给出接续演出位置；只读演出的 GET 回看不受影响。
- 多次接续只能从**当前可操作（最新接续）演出**发起；核对范围自动覆盖整条接续链，因此早期演出里的触发 / 撤回 / 申请痕迹不会丢失。
- 原有的触发、跳过、撤回及复核接口路径、请求体与响应结构保持兼容（仅新增只读拒绝与事件上的 `source` 等字段）。

**调用示例**（假设当前演出 id=1 使用 v1，目标已发布 v3，version_id=3）：

```bash
# 1) 按编号核对（只读，不改任何数据）
curl -X POST http://localhost:3000/api/performances/1/continue/preview \
  -H 'Content-Type: application/json' \
  -d '{"version_id":3}'
# → 200
# {
#   "can_continue": true,
#   "target_version": {"id":3,"version_number":3,...},
#   "hints": [
#     {"label":"L1","flags":["fired"],"flag_text":"有触发流水","records":[...]},
#     {"label":"S1","flags":["skipped"],...},
#     {"label":"L2","flags":["carried","retracted","fired"],...}
#   ],
#   "carried": [
#     {"label":"L1","action":"fired","operator":"张三","source_event_id":1,"target_cue_id":12},
#     {"label":"S1","action":"skipped","operator":"李四","source_event_id":2,"target_cue_id":13}
#   ],
#   "conflicts": [], "pending_requests": []
# }

# 2) 生成接续演出（operator 必填；name 可选，默认追加「接续 vN」）
curl -X POST http://localhost:3000/api/performances/1/continue \
  -H 'Content-Type: application/json' \
  -d '{"version_id":3,"operator":"王监","name":"10月1日 晚场（修订版）"}'
# → 200
# {
#   "performance": {"id":7,"version_id":3,"status":"active",
#                   "continued_from_performance_id":1,"continued_by":"王监",...},
#   "source_performance_id": 1,
#   "target_version": {"id":3,"version_number":3},
#   "carried_count": 2,
#   "carried": [{"label":"L1","action":"fired","operator":"张三"},
#               {"label":"S1","action":"skipped","operator":"李四"}]
# }

# 3) 冲突时（编号缺失 / 类型 / 描述 / 前置集合 / 复核标记被改，或存在待处理申请）
# → 409 {"error":"接续核对未通过，请按冲突清单处理后重试",
#        "conflicts":[{"label":"B2","reasons":["存在待处理的复核申请，接续前须先确认、撤销或驳回"]},
#                     {"label":"L1","reasons":["类型不一致：v3 为 sound，当前为 light"]}],
#        "pending_requests":[...]}
#   原演出仍为 active、可操作，数据库无接续记录

# 4) 原演出只读：后续现场操作与再次接续统一 409
curl -X POST http://localhost:3000/api/performances/1/cues/12/fire \
  -H 'Content-Type: application/json' -d '{"operator":"赵六"}'
# → 409 {"error":"该演出已按修订执行单接续（…），原演出保持原快照且为只读，请到接续演出继续操作",
#        "readonly":true,"continuation":{"performance_id":7,"version_number":3,...}}

# 5) 查看接续演出：承接流水标来源，未执行提示按新版依赖计算
curl http://localhost:3000/api/performances/7
# continuation.from = {performance_id:1, version_number:1,...}
# events 中承接项：{"action":"fired","source":"carried",
#                  "carried_from_performance_id":1,"carried_from_event_id":1, ...}
# cues[]：承接提示 status=fired/skipped；未执行提示按新 deps 计算 pending/blocked
# continue_targets：同场次更高已发布版本（为空则前端接续面板提示先发布新版）
```

目标版本不合法时的状态码：不属于本场次 / 未发布 / 版本号不更高 → 400（含中文原因）；版本不存在 → 404；缺 `operator` → 400。

## 现场成组连续处置（本轮新增）

现场需要按顺序连续处置多条提示（例如开场段落一次处理多个 cue）时，不必逐条点按钮：舞台监督在执行台顶部「📋 成组连续处置」面板按现场顺序添加清单，每项选择**编号**与**触发 / 跳过 / 撤回**并填写跳过 / 撤回原因（触发无需原因），复用顶部「操作人」作为本组操作人。

**规则**

- 仅在**当前可操作（active）演出**上可用；只读（已接续）演出拒绝预览与提交（409，附接续演出位置）
- 整组结构校验（不通过直接 400，不进入逐项判定）：本组操作人必填；`items` 为非空数组（上限 500 项）；每项编号非空、动作仅可为 `fire/skip/retract`；**同一编号在清单中不得重复**
- **逐项预览（只读）**：按清单顺序逐项判定，每一步基于**前面步骤产生的有效结果**计算——前面步骤触发的提示满足后续前置、前面步骤撤回的提示使下游重新受阻、撤回的下游保护同样把同组前序步骤计入。返回每项的通过情况或失败原因（含序号、编号），以及 `can_submit`；预览不写任何数据
- 单项规则在逐项判定中完全一致：前置未全部已触发 → 422（列出未满足编号）；已有有效结果 → 409（附当前结果）；撤回仅对有效「已触发」可用，已跳过 / 未触发拒绝，且沿前置关系可达的下游仍有有效「已触发」时拒绝（附 `affected`）；待复核申请期间该提示拒绝触发 / 跳过 / 撤回；跳过与撤回原因必填（400）
- **需双人复核的提示不得在成组中直接触发**：该步直接失败并提示去单项「申请触发」；成组操作不会登记复核申请，申请—确认仍只能走单项接口（对复核提示执行跳过不受此限，规则与单项一致）
- **整组提交**：在 `BEGIN IMMEDIATE` 事务内**按最新状态重新逐项判定**（不信任此前预览），与单项操作、接续相互串行；全部通过才按清单顺序依次写入 `manual` 流水，字段、操作人、原因与单项操作完全一致；任一项失败则整体回滚、**整组不产生任何流水**，响应给出首个失败的序号 / 编号 / 原因，并在 `results` 中给出全部逐项判定（含 400/409/422 状态），状态码取首个失败项语义（含前置失败为 422，其余为 409/400）
- 原有触发 / 跳过 / 撤回 / 复核 / 接续接口路径、请求体与响应结构均未改变

**调用示例**（假设演出 id=2，版本中 L1→S1→B1 依次为前置关系）：

```bash
# 1) 逐项预览（不改数据）：链式前置 + 跳过原因 + 复核限制一次看清
curl -X POST http://localhost:3000/api/performances/2/batch/preview \
  -H 'Content-Type: application/json' \
  -d '{"operator":"王监","items":[
        {"label":"L1","action":"fire"},
        {"label":"S1","action":"skip","reason":"设备故障，跳过开场音乐"},
        {"label":"S2","action":"fire"},
        {"label":"B2","action":"fire"}
      ]}'
# → 200
# {
#   "can_submit": false, "success_count": 1, "failure_count": 3,
#   "results": [
#     {"index":1,"label":"L1","action":"fire","ok":true,"planned":true},
#     {"index":2,"label":"S1","action":"skip","ok":true,"planned":true,"reason":"设备故障，…"},
#     {"index":3,"label":"S2","action":"fire","ok":false,"status":422,
#      "error":"前置提示未触发，无法触发：B1","unmet":["B1"]},
#     {"index":4,"label":"B2","action":"fire","ok":false,"status":409,
#      "error":"该提示需双人复核，不能在成组操作中直接触发；请先在执行台发起触发申请…"}
#   ]
# }

# 2) 全部可执行的清单整组提交：事务内重判通过后依次落流水
curl -X POST http://localhost:3000/api/performances/2/batch \
  -H 'Content-Type: application/json' \
  -d '{"operator":"王监","items":[
        {"label":"L1","action":"fire"},
        {"label":"S1","action":"fire"},
        {"label":"B1","action":"fire"}
      ]}'
# → 200 {"submitted":true,"success_count":3,"failure_count":0,
#        "results":[{"index":1,"label":"L1","ok":true,"event":{"id":21,"action":"fired",...}}, ...]}

# 3) 提交瞬间被并发单项操作抢先 / 某步前置失效：整组回滚、零流水，并指出失败项
# → 409 {"error":"成组操作未执行：第 2 项（编号 B1）前置提示未触发，无法触发：S1。整组均未生效、无流水产生…",
#        "success_count":0,"failure_count":2,
#        "results":[{"index":1,"label":"L1","ok":false,"status":409,"error":"该提示已有结果：…","current":{…}},
#                   {"index":2,"label":"B1","ok":false,"status":422,"error":"前置提示未触发，无法触发：S1","unmet":["S1"]}]}

# 4) 结构错误：空清单 / 重复编号 / 非法动作 → 400
# {"error":"第 2 项：编号「L1」在本组清单中重复，每个编号只能出现一次"}

# 5) 只读演出：预览与提交统一 409（附 readonly 与接续演出位置）
```

执行台「📋 成组连续处置」面板支持编号自动补全（datalist）、动作切换后原因栏自动启停；「逐项预览」结果在表格中按序号列出 ✓ / ✗ 与原因，「整组提交」前自动再预览一次，服务端事务内还会最终重判，成功后自动刷新提示卡片与流水。页面 2.5 秒轮询重绘不会打断正在填写的清单（焦点与光标位置保留）。

## 数据与并发说明

- `cue_events` 为**流水表**：触发 / 跳过 / 撤回逐条追加，全量留痕；同一演出同一提示的「当前有效结果」由最新一条事件推导（`retracted` 表示已撤回、当前无有效结果），至多一个当前有效结果。`source` 区分 `manual`（现场操作）与 `carried`（接续时自来源演出承接，附 `carried_from_performance_id` / `carried_from_event_id`，沿用原操作人与时间，非再次触发）
- `cue_review_requests` 为**复核申请表**：申请（申请人、时间）与处置（确认 / 撤销 / 驳回、处置人、时间、原因、关联的触发流水 `event_id`）全量留痕；`pending → confirmed / cancelled / rejected` 为终态迁移，同一提示至多一条待复核申请
- `performances` 记录接续关系：`status`（`active` 可操作 / `readonly` 已接续只读）、`continued_from_performance_id`（来源演出）、`continued_at/by`（接续时间与操作人）；接续演出绑定目标版本，原演出仍绑定原版本快照
- 触发、跳过、撤回、复核处置、**成组提交**与**接续**均在 `BEGIN IMMEDIATE` 事务内「读最新事件 / 申请 / 演出状态 → 判定 → 写入」，并发操作串行判定，后到的冲突请求收到 409 及当前结果（操作人、时间、原因、接续演出位置）。成组提交在事务内对整组清单**重新逐项判定**，任一项失败整体回滚（含同组已拟写入项），因此成组提交不可能只落一半流水；成组预览为只读快照判定（Node 单线程同步读，不穿插写操作），不写任何数据
- 前置是否满足、提示状态（待执行/已触发/已跳过/受阻）均按**当前有效结果**计算：前置被撤回后，未执行的下游提示重新变为受阻；复核确认时同样按当前有效结果判定，前置失效则确认拒绝且申请保持待复核；接续后未执行提示一律按**新版依赖**重算（承接的已触发计入满足）
- 接续前的按编号核对覆盖**整条接续链**（当前演出 + 逐级来源演出）：任一环节有触发 / 跳过 / 撤回流水、复核申请或承接结果的编号都须在新版保留其编号、类型、描述、前置集合与复核标记，且当前无待处理申请，否则整体拒绝并按编号返回原因
- 旧版数据库启动时自动迁移：`cue_events` 唯一约束表重建为流水表、`cues` 补 `needs_review` 列（既有提示默认 0，按无需复核处理），`performances` 补 `status / continued_from_performance_id / continued_at / continued_by` 列（既有演出默认 `active`），`cue_events` 补 `source / carried_from_*` 列（既有流水默认 `manual`），全部历史记录保留，无需手工操作
- 演出与版本通过外键绑定，版本发布后无更新入口（含 `needs_review` 标记），因此历史回看永远呈现演出当时的执行单内容；接续只新建演出并把原演出置为只读，**不改动任何版本快照**
- 接续关系可在执行台顶部横幅与场次页演出记录中查看；只读演出仍可随时打开回看其流水、复核申请与当时版本
