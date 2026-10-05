# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：苗圃与项目部分侧记账、按批次对账——
**苗圃**只管苗木批次的进场数量与供苗保证率；**项目部**只管栽植领用与整块地的验收测次。
测次成活株数按「在库领用」摊回苗木批次算出批次成活率，低于供苗保证率的差额自动记入结算单，等项目部确认。
同时支持分次验收成活株数与株高、成活率趋势、补植计划与缺株数回写。

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
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts settlement.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts settlementStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含批次对账与结算）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts settlement.ts nurseryQueue.ts export.ts seed.ts id.ts revision.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数、挂起领用与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | **苗圃侧**：苗木批次进场数量与供苗保证率登记（自育苗可不考核，外购默认八成）、在库/挂起对账、摊回批次成活率 |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | **项目部侧**：栽植领用（只能挑苗圃当时在库批次），超进场数量先挂起；株距株数与密度校验 |
| `/surveys` | `pages/SurveyBoard.tsx` | **项目部侧**：整块地按测次验收成活株数/株高，保存后自动摊回批次；低于阈值告警、批量调整等级 |
| `/settlements` | `pages/SettlementBoard.tsx` | 批次对账 + 结算单：保证率差额（百分点/株数）待项目部确认/驳回；苗圃侧失败只本侧重试 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移，
  `version(3)` 完成苗圃 / 项目部分账：
  * v2：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM` 索引等；
    回填 `revision` / `createdAt` / `updatedAt`；补齐 `missingCount`、`lastReplantDate`、`grade`、`gradeManual`。
  * v3：`seedlings` 增加 `guaranteeRate`（供苗保证率）；`plantings` 增加 `status` / `overQuantity`（在库 / 挂起）；
    新增 `settlements` 结算单表（含 `[seedlingId+surveyId]` 幂等索引）。
    **旧数据没记供苗保证率：自育苗不考核（`null`），外购按八成（80%）补上**；
    历史栽植按栽植日期累计重算在库 / 挂起；并按短差为外购批次补开「待确认」结算单。
* **表结构**：

  | 表 | 归属 | 主键 | 主要索引 |
  | --- | --- | --- | --- |
  | `plots` | 共用 | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `seedlings` | 苗圃 | id | plotId, species, source, arrivalDate, quantity, guaranteeRate |
  | `settlements` | 苗圃 | id | seedlingId, plotId, surveyId, status, [seedlingId+surveyId] |
  | `plantings` | 项目部 | id | plotId, seedlingId, plantDate, spacingM, status |
  | `surveys` | 项目部 | id | plotId, [plotId+round], date, grade |
  | `replants` | 项目部 | id | plotId, planDate, state, species |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 → 验收 → 补植 / 结算**：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（自育苗不考核、外购保证率 80%；北屿 c1 进场 4000 株、领用 4200 株，超出 200 株挂起）；
  * 6 条栽植记录（引用真实批次 id，其中 1 条为挂起）；
  * 7 条验收记录（每地块 2–3 个测次，整块地成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 3 条补植计划（待补植 / 已补植 / 已复核）；
  * 2 张结算单（东港 a2 第 3 测次 79.0% 差 1.0 点 / 22 株「待确认」；西湾 b2 第 2 测次 64.0% 差 16 点 / 240 株「已确认」）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」与「苗圃侧保存失败待办队列」（`gbmangrove:nurseryRetryQueue`），不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录、补植计划与结算单（同一 Dexie 事务内完成）。

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
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

### 两侧分账

* **苗圃侧**：苗木批次只登记**进场数量**与**供苗保证率**（自育苗可登记「不考核」，外购默认 80%），
  不登记地块成活率；结算单（`settlements`）归苗圃侧。
* **项目部侧**：只管**栽植领用**与整块地的**验收测次**（`plantings` / `surveys`），不改动批次的进场数量与保证率。
* **按批次对账**：两边通过 `seedlingId` 关联。苗圃补登记进场数量后，引用批次的领用在库 / 挂起状态自动重算。

### 成活率（整块地口径，项目部）

* **成活率** = 成活株数 ÷ 该地块栽植总株数（含挂起）× 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。

### 领用挂起与批次摊回

* 领用只能挑苗圃**当时在库、有余量**的批次；按栽植日期累计，**超出进场数量的整笔先挂起**
  （`status = pending`，记录 `overQuantity`），等苗圃补足进场数量后自动恢复在库。
* 测次保存后，成活株数先按在库 / 挂起占比折算给在库部分（挂起不参与），再用**最大余数法**
  按各批次在库领用株数摊回，保证各批分摊之和精确等于折算后的成活株数（`src/utils/settlement.ts`）。
* **批次成活率** = 摊回成活株数 ÷ 参与摊回领用株数；取每地块**最新测次**做批次对账，全部测次参与结算差额。

### 批次结算单

* 考核批次（保证率非空）批次成活率低于保证率时：**保证率差额（百分点）**与
  **差额株数（= 参与摊回领用株数 × 百分点差，四舍五入）**记入结算单，状态「待确认」。
* 结算单由系统按 `[批次+测次]` 幂等重算：短差在则自动更新、短差消失则自动撤单；
  **已确认 / 已驳回的单据永不被覆盖**，由项目部在 `/settlements` 确认或驳回（驳回必填原因）。
* **失败隔离**：苗圃那份（结算单）保存失败后只重试**苗圃本侧**写入（localStorage 待办队列 + 结算页手动「只重试苗圃本侧」）；
  项目部侧栽植 / 验收保存照旧成功、不回滚、不联动失败。

### 其他

* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率，随后重算批次结算单。
