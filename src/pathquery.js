'use strict';

/**
 * 目标路径查询
 *
 * 在「场景 + 完整变量状态」的具体状态空间上执行可终止的 BFS：
 * 从起点场景的初始状态（起点场景的进入赋值）出发，寻找第一个
 * 「位于目标场景 且 全部到达约束成立 且 已按顺序经过全部必经选项」的具体状态，
 * 返回最短选项链及每步状态。
 *
 * 有序必经选项（requiredOptionUids）：query 中给出一个有序 UID 列表，路径必须
 * 依次选择这些选项（先经过第 1 个，再第 2 个……）。实现上把「已完成的必经序号
 * progress」并入具体状态的去重键：(场景 ID, 变量位图, progress)。选择当前
 * 期待的必经选项时 progress + 1；只有 progress === 必经总数 才算全部完成。
 *
 * 禁用选项（forbiddenOptionUids）：这些选项在 BFS 扩展时直接跳过（不扩展），
 * 路径中不可能出现它们。
 *
 * 终止性：状态按 场景ID + 变量位图 + 必经序号 去重，具体状态总数 ≤
 * 场景数 × 2^n × (必经数 + 1)，必然有限；另有 maxStates 安全上限（与分析器一致），
 * 超限即截断——截断时未找到目标不能断言无解，结果中以 canAssertUnsolvable=false 标明。
 *
 * 无解时的回退结果：在已探索的可达状态中挑选「与目标差异最少」者——
 *   1. 目标场景上的到达状态优先（最能说明“到了但条件不对”）；
 *   2. 其次已完成的必经序号更大（未完成必经项更少）；
 *   3. 再其次缺失变量数更少；
 *   4. 同优先级保留 BFS 先到者（即路径更短）。
 * 同时返回该状态的缺失变量清单、未完成必经项与对应的最近路径。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 约束规整：忽略未选变量的空行；同一变量只允许一条约束 */
function normalizeConstraints(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('constraints 必须是 [{ variable, value }] 数组');
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const variable = String(c.variable === undefined || c.variable === null ? '' : c.variable).trim();
    if (!variable) continue; // 前端可能留有未选择变量的空行
    if (seen.has(variable)) throw badRequest(`变量 "${variable}" 的到达约束重复`);
    seen.add(variable);
    // 宽容处理字符串布尔值，避免 "false" 被 !! 误判为 true
    const value = c.value === 'false' ? false : !!c.value;
    out.push({ variable, value });
  }
  return out;
}

/** UID 列表规整：忽略空项；同一名单内不允许重复（必经项靠顺序区分，重复无意义） */
function normalizeUidList(raw, fieldName, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest(`${fieldName} 必须是选项 UID 字符串数组`);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const uid = String(item === undefined || item === null ? '' : item).trim();
    if (!uid) continue;
    if (seen.has(uid)) throw badRequest(`${label}中选项 UID "${uid}" 重复`);
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

/**
 * 执行目标路径查询。
 *
 * @param story  剧情对象（草稿或已保存均可）
 * @param query  {
 *                 targetScene,
 *                 constraints: [{ variable, value }],
 *                 requiredOptionUids: [uid, ...]  // 有序必经选项
 *                 forbiddenOptionUids: [uid, ...] // 禁用选项
 *               }
 * @param opts   { maxStates } 测试可注入更小的状态上限
 */
function queryPath(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const query = queryInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  // 选项 UID 索引（草稿中 UID 可能缺失：仅带 uid 的选项可被指定为必经 / 禁用）
  const uidIndex = new Map(); // uid -> { sceneId, option, index }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    (scene.options || []).forEach((option, idx) => {
      if (!option || option.uid === undefined || option.uid === null || option.uid === '') return;
      const uid = String(option.uid);
      if (!uidIndex.has(uid)) uidIndex.set(uid, { sceneId: scene.id, option, index: idx });
    });
  }

  const targetScene = String(query.targetScene || '').trim();
  if (!targetScene) throw badRequest('缺少目标场景 targetScene');
  if (!sceneMap.has(targetScene)) throw badRequest(`目标场景 "${targetScene}" 不存在`);
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法执行路径查询');
  }
  const constraints = normalizeConstraints(query.constraints);
  const requiredUids = normalizeUidList(query.requiredOptionUids, 'requiredOptionUids', '必经选项');
  const forbiddenUids = normalizeUidList(query.forbiddenOptionUids, 'forbiddenOptionUids', '禁用选项');

  // UID 必须存在
  for (const uid of requiredUids) {
    if (!uidIndex.has(uid)) throw badRequest(`必经选项 UID "${uid}" 在剧情中不存在`);
  }
  for (const uid of forbiddenUids) {
    if (!uidIndex.has(uid)) throw badRequest(`禁用选项 UID "${uid}" 在剧情中不存在`);
  }
  // 必经与禁用不得冲突
  const forbiddenSet = new Set(forbiddenUids);
  for (const uid of requiredUids) {
    if (forbiddenSet.has(uid)) {
      throw badRequest(`必经选项与禁用选项冲突：UID "${uid}" 不能同时出现在两个名单中`);
    }
  }

  const describeOption = (uid) => {
    const rec = uidIndex.get(uid);
    if (!rec) return { uid, text: '', sceneId: '', sceneTitle: '', target: '', optionIndex: null };
    return {
      uid,
      text: rec.option.text || '',
      sceneId: rec.sceneId,
      sceneTitle: (sceneMap.get(rec.sceneId) || {}).title || '',
      target: ((rec.option.target || '').trim()) || '',
      optionIndex: rec.index,
    };
  };
  const requiredOptions = requiredUids.map((uid, i) => ({ order: i + 1, ...describeOption(uid) }));
  const forbiddenOptions = forbiddenUids.map(describeOption);

  // 状态空间变量 = 已声明变量 ∪ 赋值中出现的变量（与分析器一致）
  const knownVars = collectStateVars({ ...story, scenes });

  // 编译条件；语法错误的条件按恒真处理（与分析器一致），并记录到 conditionErrors
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, assigns }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  // 未进入状态空间的约束变量：恒为 false（约束 value=true 时永远缺失）
  const unknownConstraintVars = constraints
    .map((c) => c.variable)
    .filter((v) => !knownVars.includes(v));

  const mismatchesOf = (state) => {
    const miss = [];
    for (const c of constraints) {
      const actual = knownVars.includes(c.variable) ? !!state[c.variable] : false;
      if (actual !== c.value) miss.push({ variable: c.variable, want: c.value, actual });
    }
    return miss;
  };

  // 去重键含已完成必经序号 progress：同一 (场景, 变量状态) 在不同必经进度下是不同局面
  const visited = new Set();        // "sceneId\x00code\x00progress"
  const parent = new Map();         // key -> { parentKey, depth, edge }
  const keyOf = (id, code, progress) => `${id}\x00${code}\x00${progress}`;
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let targetStates = 0;
  let goalKey = null;
  let closest = null;               // { key, sceneId, code, depth, miss, progress }

  const considerClosest = (key, sceneId, code, depth, miss, progress) => {
    const candidate = { key, sceneId, code, depth, miss, progress };
    if (!closest) { closest = candidate; return; }
    const atTarget = sceneId === targetScene;
    const curAtTarget = closest.sceneId === targetScene;
    if (atTarget !== curAtTarget) {
      if (atTarget) closest = candidate;
      return;
    }
    // 已完成的必经项更多（未完成必经项更少）者更接近目标
    if (progress !== closest.progress) {
      if (progress > closest.progress) closest = candidate;
      return;
    }
    if (miss.length !== closest.miss.length) {
      if (miss.length < closest.miss.length) closest = candidate;
      return;
    }
    // 同优先级：BFS 按层提供状态，先提供者路径更短
  };

  const offer = (sceneId, code, progress, depth, predKey, edge) => {
    if (truncated || goalKey) return;
    const key = keyOf(sceneId, code, progress);
    if (visited.has(key)) return;
    visited.add(key);
    statesExplored++;
    parent.set(key, { parentKey: predKey, depth, edge });
    const state = decodeState(code, knownVars);
    const miss = mismatchesOf(state);
    if (sceneId === targetScene) {
      targetStates++;
      // BFS 按层提供状态，首次命中即全局最短（更浅的状态此前都已检查过）
      if (miss.length === 0 && progress === requiredUids.length) { goalKey = key; return; }
    }
    considerClosest(key, sceneId, code, depth, miss, progress);
    if (statesExplored > maxStates) { truncated = true; return; }
    queue.push({ sceneId, code, progress, depth, key });
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点前置不成立则没有任何可达状态
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (!startBlocked) {
    offer(story.startScene, encodeState(startState, knownVars), 0, 0, null, null);
  }

  // ---- BFS 传播 ----
  let head = 0;
  while (head < queue.length && !truncated && !goalKey) {
    const cur = queue[head++];
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);
    (scene.options || []).forEach((option, idx) => {
      if (truncated || goalKey) return;
      const optionUid = option && option.uid !== undefined && option.uid !== null ? String(option.uid) : '';
      // 禁用项：不扩展（不求值条件、不入队）
      if (optionUid && forbiddenSet.has(optionUid)) return;
      const oc = optionCompiled.get(`${cur.sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return;
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return; // 入口前置不成立：不算到达
      // 有序必经：仅当选择的正是当前期待的那一条时，进度才 + 1
      let nextProgress = cur.progress;
      if (optionUid && cur.progress < requiredUids.length && requiredUids[cur.progress] === optionUid) {
        nextProgress = cur.progress + 1;
      }
      offer(targetId, encodeState(nextState, knownVars), nextProgress, cur.depth + 1, cur.key, {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
        requiredOrder: nextProgress > cur.progress ? nextProgress : null,
      });
    });
  }

  // 路径重建：scene / option 交替；scene 节点携带到达时的完整变量状态，
  // option 边携带选择后（含目标场景进入赋值）的状态 stateAfter —— 即“每步状态”
  const buildPath = (key) => {
    const trail = [];
    let k = key;
    while (k) {
      const sepIdx1 = k.indexOf('\x00');
      const sepIdx2 = k.indexOf('\x00', sepIdx1 + 1);
      const sid = k.slice(0, sepIdx1);
      const code = k.slice(sepIdx1 + 1, sepIdx2);
      const sc = sceneMap.get(sid);
      const p = parent.get(k);
      const state = decodeState(code, knownVars);
      trail.push({ kind: 'scene', sceneId: sid, title: sc ? (sc.title || '') : '', state });
      if (p && p.edge) trail.push({ kind: 'option', ...p.edge, stateAfter: state });
      k = p ? p.parentKey : null;
    }
    trail.reverse();
    return trail;
  };

  /** 从指定进度起尚未完成的必经项（保留其应有顺序号） */
  const remainingFrom = (progress) => requiredUids.slice(progress).map((uid, j) => ({
    order: progress + j + 1,
    ...describeOption(uid),
  }));

  const found = goalKey !== null;
  const targetTitle = sceneMap.get(targetScene).title || '';
  const reqText = requiredUids.length
    ? `，并依次经过全部 ${requiredUids.length} 条必经选项`
    : '';

  const result = {
    found,
    truncated,
    exhaustive: !truncated,
    // 仅在完整穷举后仍未找到时才能断言无解；截断时该标志为 false
    canAssertUnsolvable: !found && !truncated,
    statesExplored,
    maxStates,
    targetScene,
    targetTitle,
    constraints,
    knownVars,
    unknownConstraintVars,
    conditionErrors,
    startBlocked,
    targetReachable: targetStates > 0,
    targetStatesExplored: targetStates,
    // 有序必经 / 禁用（解析后的选项信息，便于前端直接展示）
    requiredOptions,
    forbiddenOptions,
    requiredTotal: requiredUids.length,
    forbiddenTotal: forbiddenUids.length,
    // 未完成必经项：命中时为空；未命中时对应“差异最少状态”处仍欠的必经项
    remainingRequired: [],
  };

  if (found) {
    const [, code] = goalKey.split('\x00');
    result.depth = parent.get(goalKey).depth;
    result.finalState = decodeState(code, knownVars);
    result.path = buildPath(goalKey);
    result.message = `找到到达 "${targetScene}"${reqText}且满足全部约束的最短选项链（${result.depth} 步）`;
    return result;
  }

  result.remainingRequired = closest ? remainingFrom(closest.progress) : requiredOptions;
  result.closest = closest ? {
    sceneId: closest.sceneId,
    title: (sceneMap.get(closest.sceneId) || {}).title || '',
    isTargetScene: closest.sceneId === targetScene,
    depth: closest.depth,
    progress: closest.progress,
    completedRequired: closest.progress,
    state: decodeState(closest.code, knownVars),
    missing: closest.miss,
    mismatchCount: closest.miss.length,
    remainingRequired: remainingFrom(closest.progress),
    path: buildPath(closest.key),
  } : null;

  if (startBlocked) {
    result.message = '起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达状态';
  } else if (truncated) {
    const remainTxt = result.remainingRequired.length
      ? `；未完成必经项 ${result.remainingRequired.length}/${requiredUids.length}`
      : '';
    result.message = `已探索 ${statesExplored} 个状态（达到上限）仍未找到满足条件的到达状态${remainTxt}；因搜索截断，不能断言无解`;
  } else {
    result.message = `已穷举全部 ${statesExplored} 个可达状态，不存在依次经过全部必经选项、到达 "${targetScene}" 且满足约束的状态（可断言无解）`;
  }
  return result;
}

module.exports = { queryPath };
