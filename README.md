# 分支剧情一致性审校台（Branching Story Auditor）

一个用于检查 **分支剧情 / 互动叙事脚本一致性** 的 Web 应用。支持为每个场景设置 **布尔前置条件、进入时状态赋值**，为每个选项设置 **显示条件、状态赋值和跳转目标**，并指定剧情起点。后端会从起点出发，按 **「场景 + 变量状态」组合状态** 进行穷举传播与去重，因此即使剧情包含环路（可反复返回的场景），分析也保证终止。

## 能发现什么问题

| 类型 | 含义 |
| --- | --- |
| **不可达场景** `unreachableScene` | 从起点出发，不存在任何选项链能进入该场景（孤岛场景 / 唯一通路选项恒假 / 入口前置冲突） |
| **条件永不成立的选项** `neverTrueOption` | 选项所在场景可达，但在所有能到达的变量状态下，该选项条件都为 false，玩家永远看不到它 |
| **悬空跳转** `orphanOption` | 选项没有目标，或跳向不存在的场景 ID |
| **入口前置冲突** `blockedEntry` | 选项本身可触发，但目标场景的前置条件在跳转后的变量状态下恒不成立（赋值与前置条件互相矛盾） |
| **结构 / 语法错误** | 未指定起点、场景 ID 重复或缺失、条件表达式语法错误、引用未声明且从未赋值的变量等 |

点击任一问题，右侧会展示：

1. **最接近的可达路径**：从起点到问题点的最短选项链（含每一步的变量状态）；
2. **未满足的条件解释树**：逐层标注每个子条件的期望值 / 实际值，并给出 **最少只需翻转哪些变量** 即可让条件成立，帮助定位是哪条状态赋值缺失或冲突。

## 一条命令启动（需要 Docker + Docker Compose）

```bash
docker compose up -d --build
```

启动后访问：

> **http://localhost:3000**

首次启动且数据目录为空时，会自动写入一份示例剧情 **《失落王权》**（其中刻意包含循环、不可达场景、恒假条件、悬空跳转等缺陷，方便直接体验审校功能）。

停止：

```bash
docker compose down          # 保留剧情数据（Docker 卷 story-data）
docker compose down -v       # 同时删除剧情数据卷
```

查看日志：

```bash
docker compose logs -f
```

容器内置健康检查：Compose 会在容器内运行随镜像分发的 Node 探针
`scripts/healthcheck.js`（仅使用 Node 内置模块，无第三方依赖）。探针**固定通过
`127.0.0.1`** 请求 `GET /api/stories`——此前使用 `wget http://localhost:...`
时，部分环境会把 `localhost` 解析到 IPv6 的 `::1`，而应用监听的是 `0.0.0.0`
（IPv4），导致服务正常却被误判为 unhealthy。探针仅在请求在超时内返回 **2xx**
且响应体可解析为 **JSON 数组**时退出 0；连接失败、超时、非 2xx 或响应体畸形
均退出非 0。探针超时由 `HEALTHCHECK_TIMEOUT_MS` 控制（默认 4000ms，小于
Compose healthcheck 的 5s 超时）。

## 不使用 Docker（本地 Node.js 运行）

要求 Node.js ≥ 18。

```bash
npm install
npm start
```

默认同样监听 **http://localhost:3000**，剧情数据保存在项目下的 `./data/` 目录，示例剧情在首次启动时自动播种。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口。Compose 映射宿主机端口可直接修改 `docker-compose.yml` 中 `"3000:3000"` 的左侧值 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | Docker 内 `/app/data`；本地 `./data` | 剧情 JSON 文件的持久化目录 |
| `SEED_ON_START` | `true` | 数据目录为空时是否自动播种 `samples/` 下的示例剧情；设为 `false` 关闭 |
| `HEALTHCHECK_TIMEOUT_MS` | `4000` | 容器健康检查探针自身的请求超时（毫秒），需小于 Compose healthcheck 的 `timeout`（5s）；仅容器内探针使用 |

## 条件表达式语法

选项条件与场景前置条件使用布尔表达式：

- 变量名：以字母 / 下划线开头，仅含字母、数字、下划线，如 `hasKey`；
- 与 / 或 / 非：`a && b`、`a || b`、`!a`；
- 括号：`(a || b) && !c`；
- 留空表示 **恒真**；
- 未定义的变量按 `false` 处理；若变量既未在“布尔变量”中声明、也从未被任何赋值设置，分析结果会额外给出警告。

## 剧情 JSON 格式（同时也是导入 / 导出格式）

```json
{
  "title": "剧情标题",
  "description": "可选简介",
  "startScene": "village",
  "variables": [
    { "name": "hasKey", "description": "是否持有钥匙" }
  ],
  "scenes": [
    {
      "id": "village",
      "title": "宁静村",
      "text": "场景正文……",
      "precondition": "",
      "assigns": [],
      "options": [
        {
          "text": "走进森林",
          "condition": "!hasKey",
          "target": "forest",
          "assigns": [{ "variable": "hasKey", "value": true }]
        }
      ]
    }
  ]
}
```

- 场景 `assigns`：**进入场景时** 执行的赋值（包括从起点进入）；
- 选项 `assigns`：选择该选项时执行的赋值，随后再执行目标场景的进入赋值；
- 选项 `uid`：可选的稳定身份标识，基线对比用它识别“同一条选项”（不随选项拖动重排而变）；留空时保存会自动生成；
- 顶层 `baseline`：分析基线快照（由「保存分析基线」生成，也可随导入 JSON 携带，无效快照会被忽略）；
- 起点场景的初始变量状态 = 全部为 `false` 再叠加起点场景自身的进入赋值。

导入通过页面右上角 **「⬆ 导入 JSON」** 完成（导入总是创建一份新剧情，不会覆盖现有内容）；导出使用 **「⬇ 导出 JSON」** 或接口 `GET /api/stories/:id/export`。

## 分析原理（为什么含循环也能终止）

分析器把每个可达局面编码为 `(场景 ID, 全部布尔变量的取值位图)`：

1. 以起点场景 + 其进入赋值后的状态作为初始具体状态；
2. BFS 遍历：对当前具体状态下的每个选项求值条件——成立则应用选项赋值与目标场景的进入赋值，得到新具体状态；
3. 新状态按 `场景 + 状态位图` 去重，已访问过就不再入队。

布尔变量数为 n 时，具体状态总数至多为 `场景数 × 2^n`，必然有限，所以任意循环都不会导致分析发散（设有约 100 万状态的安全上限，超限会在结果中提示“分析截断”）。

“条件永不成立”的判定：若某选项 **被到达过**，但在所有到达它的具体状态下条件都不成立，则该选项对玩家不可见；只要存在任意一个可达状态使条件成立，即视为正常。

## 分析基线（对比修订前后）

在右栏「一致性分析」中可以把**当前分析结果保存为基线**，随后继续编辑剧情并随时「运行对比」：

| 对比状态 | 含义 |
| --- | --- |
| **新增** `new` | 基线时不存在、当前分析中出现的问题 |
| **已修复** `fixed` | 基线时存在、当前分析中已消失的问题 |
| **仍存在** `persistent` | 同一条问题仍在，路径与文案也没有变化 |
| **详情变化** `changed` | 同一条问题仍在，但**最短可达路径或问题文案发生了变化**；详情面板中可用「当前路径 / 基线路径」标签对照前后路径，文案变化则同时展示基线与当前两版消息 |

对比结果上方有差异摘要（各类计数）与按状态筛选的按钮；对比之后若继续编辑，会提示「对比结果可能过期」，重新运行对比即可。

**稳定指纹（为什么重排场景 / 选项不会错配）**：后端为每条问题生成一个不依赖任何数组顺序的指纹，身份要素为：

- 问题类型（不可达场景 / 悬空跳转 / 入口冲突 / 恒假选项 / 结构错误）；
- 场景 ID、**选项稳定 UID**（随剧情持久化，保存旧剧情时自动回填；导入的旧数据缺失时用 `场景ID#数组下标` 兜底）；
- 关键目标场景 ID（如悬空跳转指向的目标）。

指纹只对这些身份要素做规范化 JSON 序列化（对象键排序）后取 SHA-1，路径、文案、变量状态等易变内容不参与指纹，因此移动场景顺序、调整选项排列、修改正文都不会让同一条问题被误判为“新增”。

基线快照（保存时间、问题指纹、前后对比所需的路径与消息）以 `baseline` 字段**随剧情 JSON 一起持久化**，导出 / 导入 JSON 时一并携带；删除剧情即删除基线，也可单独「删除基线」。保存基线会同时把当前草稿落盘，保证基线与保存内容一致。

## 目标路径查询

编辑页右侧的「目标路径查询」面板回答另一类问题：**“怎样走才能在到达某场景时让指定变量为真 / 为假？”**

1. 选择 **目标场景**，并可添加若干条 **到达约束**（变量 = true / false；不添加约束则只要求到达目标场景）；
2. 后端在「场景 + 完整变量状态」的具体状态空间上执行 **可终止的 BFS**（与分析器相同的状态去重与约 100 万状态上限），返回 **满足约束的最短选项链及每步状态**（每个场景节点带到达时的完整变量取值，每条选项边带选择后的状态）；
3. **无解时**返回与目标约束 **差异最少的可达状态**（目标场景上的到达状态优先，其次缺失变量更少、路径更短）、**缺失变量清单**（变量、期望值、实际值）以及到达该状态的 **最近路径**；目标场景本身不可达时，回退到全剧情中最接近约束的可达状态并明确标注；
4. 若搜索因 **状态上限被截断**，结果以 `canAssertUnsolvable: false` 标明 **不能断言无解**（只有完整穷举后才敢下“无解”结论）；
5. 查询针对的是 **编辑中的草稿**（不落盘）；剧情或查询条件被修改后，旧结果会标记为 **可能过期**，重新「查询路径」即可。

响应要点：`found`（是否命中）、`depth`（选项链长度）、`path`（场景/选项交替的每步状态）、`finalState`；无解时 `closest`（差异最少状态、缺失变量 `missing`、最近路径 `path`）、`canAssertUnsolvable`、`truncated`、`statesExplored`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/stories` | 剧情列表 |
| `POST` | `/api/stories` | 新建剧情 |
| `GET` | `/api/stories/:id` | 读取剧情完整 JSON |
| `PUT` | `/api/stories/:id` | 保存（整体覆盖） |
| `DELETE` | `/api/stories/:id` | 删除剧情 |
| `POST` | `/api/analyze` | 对请求体中的剧情直接分析（编辑时实时检查，不落盘） |
| `GET` | `/api/stories/:id/analysis` | 分析已保存的剧情 |
| `POST` | `/api/pathquery` | 目标路径查询：对请求体中的草稿剧情直接查询（不落盘），请求体 `{ story, query }` |
| `POST` | `/api/stories/:id/pathquery` | 对已保存剧情做目标路径查询，请求体即 `query` |
| `POST` | `/api/stories/:id/baseline` | 把请求体中的剧情分析结果保存为基线（同时落盘剧情），返回 `{ story, baseline, analysis }` |
| `POST` | `/api/stories/:id/baseline/compare` | 基线对比；请求体可省略（对比已保存剧情）或传入编辑中的草稿，返回 `{ summary, items }` |
| `DELETE` | `/api/stories/:id/baseline` | 删除基线（剧情内容不变） |
| `GET` | `/api/stories/:id/export` | 下载剧情 JSON（含基线） |

对比结果 `summary` 形如 `{ total, new, fixed, persistent, changed }`；`items` 中每条为 `{ status, issue, before, changes }`（`issue` 为当前问题、`before` 为基线快照；`changes` 为 `['path']` / `['message']`）。每条问题都带 `fingerprint` 字段（16 位 SHA-1）。

路径查询的 `query` 形如 `{ "targetScene": "throneRoom", "constraints": [{ "variable": "hasKey", "value": true }] }`；响应中 `found=true` 时含 `depth` / `path` / `finalState`，否则含 `closest`（差异最少状态、缺失变量 `missing`、最近路径）与 `canAssertUnsolvable`（为 `false` 表示因状态上限截断、不能断言无解）。

## 目录结构

```
.
├── server.js              # Express 入口与 REST API（含基线、目标路径查询接口）
├── src/
│   ├── expression.js      # 布尔表达式递归下降解析器 / 求值 / 失败解释
│   ├── analyzer.js        # 「场景+状态」BFS 传播去重分析引擎（附带问题指纹）
│   ├── pathquery.js       # 目标路径查询：可终止 BFS 求最短选项链 / 差异最少可达状态
│   ├── fingerprint.js     # 不依赖数组顺序的问题稳定指纹
│   ├── baseline.js        # 基线快照构建与新增/已修复/仍存在/详情变化对比
│   └── storage.js         # JSON 文件存储、首启播种、选项 UID 与基线持久化
├── public/                # 原生 HTML / CSS / JavaScript 前端（无构建步骤）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── samples/               # 随启动初始化的示例剧情
├── scripts/
│   └── healthcheck.js      # 容器健康检查探针（固定走 127.0.0.1，无第三方依赖）
├── test/
│   ├── smoke.js           # 分析引擎自检（node test/smoke.js）
│   ├── baseline.js        # 指纹 / 基线对比 / 持久化自检（node test/baseline.js）
│   ├── pathquery.js       # 目标路径查询与 API 自检（node test/pathquery.js）
│   └── healthcheck.js     # 健康检查探针回归测试（node test/healthcheck.js）
├── Dockerfile
└── docker-compose.yml
```

自检：

```bash
npm test          # 依次运行 smoke.js、baseline.js、pathquery.js 与 healthcheck.js
```

## 技术栈

Node.js + Express（唯一运行期依赖）、原生 HTML/CSS/JavaScript 单页前端、JSON 文件持久化（无需数据库）、Node 20 Alpine 镜像。
