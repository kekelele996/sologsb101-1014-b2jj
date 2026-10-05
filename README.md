# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理：**苗圃 / 项目部两摊分家，各记各的账**。

* **苗圃侧**只管苗木批次的**进场数量**与**供苗保证率**，并留自己的供苗流水账；
  测次成活株数按领用摊回批次算出批次成活率，低于保证率的差额进**批次结算单**，等项目部确认。
* **项目部侧**只管地块的**栽植领用**与**验收测次**：领用时挑苗圃当时在库的批次，
  在库够多少落实多少，**超出进场数量的部分先挂起**；成活率按整块地块、已落实株数计算。
* 一次跨侧动作两侧各自落账：苗圃那份保存失败后**只重试苗圃侧**，项目部侧照旧提交、不回滚。
* 旧数据（v2 及以前）没记供苗保证率，升级时**自育苗不考核、外购按八成（80%）补登**。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航（苗圃侧/项目部侧）+ 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts ledger.ts settlement.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts nurseryStore.ts requisitionStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（苗圃供苗台、批次结算对账、地块/领用/验收/补植）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts batch.ts sides.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 归属 | 功能 |
| --- | --- | --- | --- |
| `/nursery` | `pages/SeedlingBoard.tsx` | 苗圃侧 | 苗木批次进场登记：进场数量、供苗保证率（自育苗不考核）、在库/已供苗、苗圃供苗流水账、本侧重试队列与故障模拟 |
| `/settlements` | `pages/SettlementBoard.tsx` | 苗圃侧 | 批次结算与两摊对账：批次成活率、保证率差额结算单、项目部确认 |
| `/plots` | `pages/PlotList.tsx` | 项目部侧 | 修复地块台账：新建/编辑/删除（苗圃账由本侧重算清理）、回显已落实株数/挂起数/最新成活率 |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 项目部侧 | 栽植领用：挑苗圃当时在库批次，超出在库先挂起；按面积/株距校验密度 |
| `/surveys` | `pages/SurveyBoard.tsx` | 项目部侧 | 成活率与株高验收台：按测次录入、按地块算成活率、低阈值告警、批量调整等级 |
| `/replants` | `pages/ReplantPlan.tsx` | 项目部侧 | 补植计划：状态流转、行内草稿、JSON 导入导出、结构版本查看 |

`/` 重定向到 `/plots`，旧版 `/plots/:id/seedlings` 重定向到 `/nursery`（批次改为苗圃全局登记）。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/plantings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`：
  * `version(1)`：初版全部表；
  * `version(2)`：补 `updatedAt`、`[plotId+round]` 复合索引、`spacingM` 索引，回填修订号、地块缺株数、验收等级；
  * `version(3)`：**苗圃 / 项目部分家**——
    * 苗木批次去掉地块归属，新增 `guaranteeRate`（供苗保证率，自育苗 `null` 不考核），新增 `nurseryOutflows`、`settlements`、`outbox` 三张表；
    * 栽植领用新增 `fulfilledCount` / `status`（已落实 / 部分挂起 / 挂起）；
    * 旧数据迁移：自育苗不考核、**外购按 80% 补登保证率**；历史栽植全部视为已落实；
      按地块最新测次把成活株数摊回批次，历史保证率差额补进结算单（待项目部确认），并补登苗圃供苗流水账。
* **表结构**（侧别见标注）：

  | 表 | 侧别 | 主键 | 主要索引 |
  | --- | --- | --- | --- |
  | `plots` | 项目部 | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `plantings` | 项目部 | id | plotId, seedlingId, plantDate, spacingM, status |
  | `surveys` | 项目部 | id | plotId, [plotId+round], date, grade |
  | `replants` | 项目部 | id | plotId, planDate, state, species |
  | `seedlings` | 苗圃 | id | species, source, arrivalDate, quantity, guaranteeRate |
  | `nurseryOutflows` | 苗圃 | id | seedlingId, plotId, plantingId, action, date |
  | `settlements` | 苗圃 | id | seedlingId, plotId, surveyId, round, status |
  | `outbox` | 跨侧重试 | id | side, kind, status, dedupeKey |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次；启动时还会自动重放 `outbox` 中遗留的本侧重试任务。播种链路为：
  * 苗圃侧：6 个苗木批次（自育苗不考核 / 外购带 85%–95% 保证率）→ 供苗流水账 → 2 张结算单（1 待确认 / 1 已确认）；
  * 项目部侧：3 个地块 → 6 条栽植领用（含 1 条在库不足「部分挂起」）→ 7 条验收测次 → 3 条补植计划。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 只保存「最近选中的地块 id」和「苗圃保存失败模拟开关」两个界面偏好，不存业务数据。
* **删除地块**：项目部侧在一个事务内清理本侧的领用 / 验收 / 补植；苗圃侧流水账与结算单由独立的本侧重算任务清理，
  苗圃清理失败只重试苗圃侧，地块删除不回滚。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run test:e2e     # 纯函数口径 + v3 迁移 + 两摊侧重试的端到端断言（fake-indexeddb）
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **两摊分家**：苗圃管批次进场数量与供苗保证率；项目部管栽植领用与验收测次。批次是苗圃全局在库资源，
  地块与批次的关系只存在于领用记录里。
* **在库与领用挂起**：某批次在库 = 进场数量 − 已落实领用；领用时按当时在库分配，
  `已落实 = min(领用, 在库)`，超出部分状态为「挂起 / 部分挂起」，**挂起不占在库、不计入栽植总株数**。
* **地块成活率** = 测次成活株数 ÷ 该地块**已落实**栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活摊回批次**（`src/utils/batch.ts`）：把测次成活株数按各批次已落实领用比例摊回，
  采用**最大余数法**保证各批次摊回整数之和恰好等于测次成活株数（守恒、不重不漏）。
  **批次成活率** = 摊回成活 ÷ 摊回栽植。
* **供苗保证率与结算**：自育苗 `guaranteeRate = null` 不考核；外购登记保证率。
  批次成活率低于保证率时，差额株数 = 保证成活株数 − 摊回成活株数，记入 `settlements`（待项目部确认）；
  已确认且差额未变的结算行在重算时保留确认状态。两摊按批次对账（苗圃出库账 vs 项目部落实账）。
* **各记各的、失败只重试本侧**：领用 / 验收 / 删地块时，项目部侧先提交自己的事务，苗圃侧再登记流水账/结算单；
  苗圃那份失败只把**苗圃侧**幂等动作（`outflow-sync` / `settlement-sync` / `plot-purge`）放进 `outbox`，
  按 `side + dedupeKey` 去重，稍后只重放本侧，项目部侧不回滚。`/nursery` 页提供「苗圃保存失败」模拟开关可现场验证。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株（按已落实株数计）；过密/过疏都会给出提示。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」/ 已落实总株数重算最新一次验收的成活率。
