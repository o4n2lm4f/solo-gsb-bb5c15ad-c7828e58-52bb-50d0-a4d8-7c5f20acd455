'use strict';

/**
 * 目标路径查询
 *
 * 在「场景 + 完整变量状态」的具体状态空间上执行可终止的 BFS：
 * 从起点场景的初始状态（起点场景的进入赋值）出发，寻找第一个
 * 「位于目标场景 且 全部到达约束成立」的具体状态，返回最短选项链及每步状态。
 *
 * 终止性：状态按 场景ID + 变量位图 去重，具体状态总数 ≤ 场景数 × 2^n，
 * 因此含循环的剧情也必然终止；另有 maxStates 安全上限（与分析器一致），
 * 超限即截断——截断时未找到目标不能断言无解，结果中以 canAssertUnsolvable=false 标明。
 *
 * 无解时的回退结果：在已探索的可达状态中挑选「与目标约束差异最少」者——
 *   1. 目标场景上的到达状态优先（最能说明“到了但变量不对”）；
 *   2. 其次缺失变量数更少；
 *   3. 再其次路径更短（BFS 提供顺序保证，先提供者胜）。
 * 同时返回该状态的缺失变量清单（变量、期望值、实际值）与对应的最近路径。
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

/**
 * 执行目标路径查询。
 *
 * @param story  剧情对象（草稿或已保存均可）
 * @param query  { targetScene, constraints: [{ variable, value }] }
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

  const targetScene = String(query.targetScene || '').trim();
  if (!targetScene) throw badRequest('缺少目标场景 targetScene');
  if (!sceneMap.has(targetScene)) throw badRequest(`目标场景 "${targetScene}" 不存在`);
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法执行路径查询');
  }
  const constraints = normalizeConstraints(query.constraints);

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

  const visited = new Set();        // "sceneId\x00code"
  const parent = new Map();         // key -> { parentKey, depth, edge }
  const keyOf = (id, code) => `${id}\x00${code}`;
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let targetStates = 0;
  let goalKey = null;
  let closest = null;               // { key, sceneId, code, depth, miss }

  const considerClosest = (key, sceneId, code, depth, miss) => {
    if (!closest) { closest = { key, sceneId, code, depth, miss }; return; }
    const atTarget = sceneId === targetScene;
    const curAtTarget = closest.sceneId === targetScene;
    if (atTarget !== curAtTarget) {
      if (atTarget) closest = { key, sceneId, code, depth, miss };
      return;
    }
    if (miss.length < closest.miss.length) closest = { key, sceneId, code, depth, miss };
  };

  const offer = (sceneId, code, depth, predKey, edge) => {
    if (truncated || goalKey) return;
    const key = keyOf(sceneId, code);
    if (visited.has(key)) return;
    visited.add(key);
    statesExplored++;
    parent.set(key, { parentKey: predKey, depth, edge });
    const state = decodeState(code, knownVars);
    const miss = mismatchesOf(state);
    if (sceneId === targetScene) {
      targetStates++;
      // BFS 按层提供状态，首次命中即全局最短（更浅的状态此前都已检查过）
      if (miss.length === 0) { goalKey = key; return; }
    }
    considerClosest(key, sceneId, code, depth, miss);
    if (statesExplored > maxStates) { truncated = true; return; }
    queue.push({ sceneId, code, depth, key });
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点前置不成立则没有任何可达状态
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (!startBlocked) {
    offer(story.startScene, encodeState(startState, knownVars), 0, null, null);
  }

  // ---- BFS 传播 ----
  let head = 0;
  while (head < queue.length && !truncated && !goalKey) {
    const cur = queue[head++];
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);
    (scene.options || []).forEach((option, idx) => {
      if (truncated || goalKey) return;
      const oc = optionCompiled.get(`${cur.sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return;
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return; // 入口前置不成立：不算到达
      offer(targetId, encodeState(nextState, knownVars), cur.depth + 1, cur.key, {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
      });
    });
  }

  // 路径重建：scene / option 交替；scene 节点携带到达时的完整变量状态，
  // option 边携带选择后（含目标场景进入赋值）的状态 stateAfter —— 即“每步状态”
  const buildPath = (key) => {
    const trail = [];
    let k = key;
    while (k) {
      const [sid, code] = k.split('\x00');
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

  const found = goalKey !== null;
  const targetTitle = sceneMap.get(targetScene).title || '';

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
  };

  if (found) {
    const [, code] = goalKey.split('\x00');
    result.depth = parent.get(goalKey).depth;
    result.finalState = decodeState(code, knownVars);
    result.path = buildPath(goalKey);
    result.message = `找到到达 "${targetScene}" 且满足全部约束的最短选项链（${result.depth} 步）`;
    return result;
  }

  result.closest = closest ? {
    sceneId: closest.sceneId,
    title: (sceneMap.get(closest.sceneId) || {}).title || '',
    isTargetScene: closest.sceneId === targetScene,
    depth: closest.depth,
    state: decodeState(closest.code, knownVars),
    missing: closest.miss,
    mismatchCount: closest.miss.length,
    path: buildPath(closest.key),
  } : null;

  if (startBlocked) {
    result.message = '起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达状态';
  } else if (truncated) {
    result.message = `已探索 ${statesExplored} 个状态（达到上限）仍未找到满足约束的到达状态；因搜索截断，不能断言无解`;
  } else {
    result.message = `已穷举全部 ${statesExplored} 个可达状态，不存在到达 "${targetScene}" 且满足约束的状态（可断言无解）`;
  }
  return result;
}

module.exports = { queryPath };
