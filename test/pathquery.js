'use strict';

// 目标路径查询自检（node test/pathquery.js）
// 覆盖：最短选项链、每步状态、无解时的差异最少可达状态与缺失变量、
//       状态上限截断（不能断言无解）、循环终止、参数校验、HTTP API、
//       有序必经选项（progress 纳入去重键）、禁用选项、必经/禁用冲突与 UID 校验。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { queryPath } = require('../src/pathquery');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// ---------- 最短选项链 ----------
console.log('最短路径：');
// 直路 1 步到 c 但 k=false；绕路 2 步可带 k=true
const story1 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    {
      id: 'a', options: [
        { text: '直接走', target: 'c' },
        { text: '先拿钥匙', target: 'b', assigns: [{ variable: 'k', value: true }] },
      ],
    },
    { id: 'b', options: [{ text: '前进', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r1 = queryPath(story1, { targetScene: 'c', constraints: [{ variable: 'k', value: true }] });
ok('找到满足约束的路径', r1.found === true);
ok('最短为绕路 2 步（直路不满足约束）', r1.depth === 2);
ok('路径经过 a -> b -> c',
  r1.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 'a,b,c');
ok('最终状态满足约束', r1.finalState.k === true);
ok('选项链即路径中的 option 节点（2 条）',
  r1.path.filter((n) => n.kind === 'option').length === 2);
ok('每步状态：场景节点携带到达时完整变量状态',
  r1.path.filter((n) => n.kind === 'scene').every((n) => n.state && typeof n.state.k === 'boolean'));
ok('每步状态：选项边携带选择后状态 stateAfter',
  r1.path.filter((n) => n.kind === 'option').every((n) => n.stateAfter && typeof n.stateAfter.k === 'boolean'));
ok('选项边携带稳定 UID 字段（无 uid 时为 null）',
  r1.path.filter((n) => n.kind === 'option').every((n) => 'optionUid' in n));

// 无约束：仅要求到达目标场景
const r1b = queryPath(story1, { targetScene: 'c' });
ok('无约束时直路 1 步即最短', r1b.found && r1b.depth === 1);

// 零步：目标即起点且约束已满足
const r1c = queryPath(story1, { targetScene: 'a' });
ok('目标为起点时 0 步到达', r1c.found && r1c.depth === 0 && r1c.path.length === 1);

// 约束要求 false：到达时变量必须为假
const r1d = queryPath(story1, { targetScene: 'c', constraints: [{ variable: 'k', value: false }] });
ok('约束 value=false 时直路（k 保持 false）命中', r1d.found && r1d.depth === 1 && r1d.finalState.k === false);

// ---------- 无解：差异最少的可达状态 ----------
console.log('无解回退：');
const story2 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ text: '去', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r2 = queryPath(story2, { targetScene: 'c', constraints: [{ variable: 'k', value: true }] });
ok('未找到满足约束的到达状态', r2.found === false);
ok('完整穷举后可断言无解', r2.canAssertUnsolvable === true && r2.truncated === false);
ok('差异最少状态在目标场景上', r2.closest && r2.closest.isTargetScene === true && r2.closest.sceneId === 'c');
ok('缺失变量为 k（需 true 实际 false）',
  r2.closest.missing.length === 1 && r2.closest.missing[0].variable === 'k' &&
  r2.closest.missing[0].want === true && r2.closest.missing[0].actual === false);
ok('附带到达该状态的最近路径（1 步）', r2.closest.depth === 1 && r2.closest.path.length === 3);

// 目标场景不可达：回退到全剧情中最接近约束的可达状态
const story3 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ text: '设 k', target: 'b', assigns: [{ variable: 'k', value: true }] }] },
    { id: 'b', options: [] },
    { id: 'isolated', options: [] },
  ],
};
const r3 = queryPath(story3, { targetScene: 'isolated', constraints: [{ variable: 'k', value: true }] });
ok('目标不可达时仍无解', r3.found === false && r3.targetReachable === false);
ok('回退到差异最少的其他可达状态（b，k=true）',
  r3.closest.isTargetScene === false && r3.closest.sceneId === 'b' && r3.closest.mismatchCount === 0);

// 入口前置条件挡住 => 目标不可达
const story3b = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ text: '去', target: 't', assigns: [{ variable: 'k', value: false }] }] },
    { id: 't', precondition: 'k', options: [] },
  ],
};
const r3b = queryPath(story3b, { targetScene: 't' });
ok('被入口前置挡住的场景视为不可达', r3b.found === false && r3b.targetReachable === false);

// 起点前置不成立：没有任何可达状态
const story3c = {
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', precondition: 'k', options: [] }],
};
const r3c = queryPath(story3c, { targetScene: 'a' });
ok('起点被挡时 startBlocked 且无最近状态', r3c.startBlocked === true && r3c.closest === null && r3c.found === false);

// 约束变量未声明且从未赋值：恒为 false
const r3d = queryPath(story2, { targetScene: 'c', constraints: [{ variable: 'ghost', value: true }] });
ok('未知约束变量被列出', r3d.unknownConstraintVars.join() === 'ghost');
ok('未知变量按 false 计入缺失', r3d.closest.missing.some((m) => m.variable === 'ghost' && m.actual === false));
const r3e = queryPath(story2, { targetScene: 'c', constraints: [{ variable: 'ghost', value: false }] });
ok('未知变量约束 value=false 时可满足', r3e.found === true);

// ---------- 截断：不能断言无解 ----------
console.log('状态上限截断：');
const r4 = queryPath(story2, { targetScene: 'c', constraints: [{ variable: 'k', value: true }] }, { maxStates: 1 });
ok('达到状态上限时标记截断', r4.truncated === true && r4.exhaustive === false);
ok('截断时不能断言无解', r4.canAssertUnsolvable === false);
ok('截断时仍返回差异最少状态与缺失变量', r4.closest && r4.closest.missing.length === 1);
ok('截断提示文案明确', /不能断言无解/.test(r4.message));

// ---------- 循环终止 ----------
console.log('循环终止性：');
const loopStory = {
  startScene: 's1',
  variables: ['x'],
  scenes: [
    {
      id: 's1', options: [
        { text: '循环', condition: '!x', target: 's1', assigns: [{ variable: 'x', value: true }] },
        { text: '继续', condition: 'x', target: 's2' },
      ],
    },
    { id: 's2', options: [{ text: '回去', target: 's1', assigns: [{ variable: 'x', value: false }] }] },
  ],
};
const r5 = queryPath(loopStory, { targetScene: 's2', constraints: [{ variable: 'x', value: true }] });
ok('含循环剧情查询正常终止并命中', r5.found === true && r5.depth === 2);
const r5b = queryPath(loopStory, { targetScene: 's2', constraints: [{ variable: 'x', value: false }] });
ok('循环剧情中无解也能穷举终止', r5b.found === false && r5b.canAssertUnsolvable === true);

// ---------- 参数校验 ----------
console.log('参数校验：');
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
ok('缺少目标场景 => 400', throws400(() => queryPath(story1, {}), /targetScene/));
ok('目标场景不存在 => 400', throws400(() => queryPath(story1, { targetScene: 'ghost' }), /不存在/));
ok('缺少有效起点 => 400', throws400(() => queryPath({ scenes: [{ id: 'a' }] }, { targetScene: 'a' }), /起点/));
ok('同一变量重复约束 => 400', throws400(
  () => queryPath(story1, { targetScene: 'c', constraints: [{ variable: 'k', value: true }, { variable: 'k', value: false }] }),
  /重复/));
ok('空变量约束行被忽略', queryPath(story1, { targetScene: 'c', constraints: [{ variable: '', value: true }] }).found === true);
ok('字符串 "false" 约束值按 false 处理',
  queryPath(story1, { targetScene: 'c', constraints: [{ variable: 'k', value: 'false' }] }).depth === 1);

// ---------- 条件语法错误容错 ----------
const badCondStory = {
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: 'x', condition: 'k &&', target: 'b' }] }, { id: 'b', options: [] }],
};
const r6 = queryPath(badCondStory, { targetScene: 'b' });
ok('语法错误的条件按恒真处理并记录', r6.found === true && r6.conditionErrors.length === 1);

// ---------- 示例剧情 ----------
console.log('示例剧情：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rd1 = queryPath(demo, { targetScene: 'throneRoom', constraints: [{ variable: 'hasKey', value: true }] });
ok('示例：带钥匙到王座厅可达', rd1.found === true && rd1.finalState.hasKey === true);
ok('示例：路径每步状态完整',
  rd1.path.filter((n) => n.kind === 'scene').every((n) => n.state && 'hasKey' in n.state));
const rd2 = queryPath(demo, {
  targetScene: 'treasureRoom',
  constraints: [{ variable: 'hasKey', value: true }, { variable: 'witchHelp', value: true }],
});
ok('示例：宝库不可达（前置恒被赋值挡住）', rd2.found === false && rd2.targetReachable === false);
ok('示例：回退到约束全满足但非目标场景的最近状态',
  rd2.closest && rd2.closest.isTargetScene === false && rd2.closest.mismatchCount === 0);
ok('示例：可断言无解（状态空间完整穷举）', rd2.canAssertUnsolvable === true);

// ---------- 有序必经选项 ----------
console.log('有序必经选项：');
// 直路 1 步到 c；绕路 a->b->d->c 依次经过 take(get)->deliver，3 步；
// a->b 之后也可直接 b->c（2 步）但不经过 deliver，不算命中
const storyR = {
  startScene: 'a',
  variables: [],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'u-direct', text: '直接走', target: 'c' },
        { uid: 'u-take', text: '先取东西', target: 'b' },
      ],
    },
    {
      id: 'b', options: [
        { uid: 'u-bc', text: '直接去 c', target: 'c' },
        { uid: 'u-deliver', text: '送到 d', target: 'd' },
      ],
    },
    { id: 'd', options: [{ uid: 'u-dc', text: '到 c', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const rr1 = queryPath(storyR, { targetScene: 'c', requiredOptionUids: ['u-take', 'u-deliver'] });
ok('按必经顺序命中', rr1.found === true);
ok('最短为 3 步（2 步的 b->c 跳过第 2 条必经项）', rr1.depth === 3);
ok('路径 a -> b -> d -> c',
  rr1.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 'a,b,d,c');
ok('路径选项 UID 即 take -> deliver -> dc',
  rr1.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(',') === 'u-take,u-deliver,u-dc');
ok('必经边携带顺序号 requiredOrder（1、2），非必经边为 null',
  JSON.stringify(rr1.path.filter((n) => n.kind === 'option').map((n) => n.requiredOrder)) === '[1,2,null]');
ok('命中时未完成必经项为空', Array.isArray(rr1.remainingRequired) && rr1.remainingRequired.length === 0);
ok('结果回显必经/禁用解析信息',
  rr1.requiredOptions.length === 2 && rr1.requiredOptions[0].order === 1 &&
  rr1.requiredOptions[0].sceneId === 'a' && rr1.requiredOptions[1].uid === 'u-deliver');

// 顺序给反：[deliver, take] —— deliver 在 b，take 在 a，物理上无法按此顺序到达
const rr2 = queryPath(storyR, { targetScene: 'c', requiredOptionUids: ['u-deliver', 'u-take'] });
ok('必经顺序不可达 => 无解', rr2.found === false && rr2.canAssertUnsolvable === true);
ok('无解结果列出最近状态处未完成的必经项（已完成 deliver，仍欠 take，顺序号 2 保留）',
  rr2.remainingRequired.length === 1 &&
  rr2.remainingRequired[0].order === 2 && rr2.remainingRequired[0].uid === 'u-take');
ok('最近状态在目标场景上且已完成 1 条必经项',
  rr2.closest && rr2.closest.isTargetScene === true && rr2.closest.completedRequired === 1);

// 无任何必经项可完成时，最近状态进度为 0，未完成清单为全部必经项
const rr2b = queryPath(storyR, { targetScene: 'c', requiredOptionUids: ['u-dc', 'u-take'] });
// u-dc 在 d（d->c），完成后无后续场景可再取 take
ok('后续必经无法完成时未完成清单保留其顺序号',
  rr2b.found === false && rr2b.remainingRequired.length === 1 && rr2b.remainingRequired[0].uid === 'u-take');

// 乱序经过不算完成：b 上有必经 1(w3)/必经 2(w2) 两个选项都到 c；c 可回 b 或直去终点 t。
// 乱序捷径 w2->(回b)w3->t 在到达 t 时进度只有 1，不得命中；必须 w3 后再经过 w2。
const storyOrder = {
  startScene: 'a',
  variables: [],
  scenes: [
    { id: 'a', options: [{ uid: 'w-ab', text: '进入 b', target: 'b' }] },
    {
      id: 'b', options: [
        { uid: 'w2', text: '必经 2', target: 'c' },
        { uid: 'w3', text: '必经 1', target: 'c' },
      ],
    },
    {
      id: 'c', options: [
        { uid: 'w-back', text: '返回 b', target: 'b' },
        { uid: 'w-go', text: '直去终点（乱序时的捷径）', target: 't' },
      ],
    },
    { id: 't', options: [] },
  ],
};
const ro = queryPath(storyOrder, { targetScene: 't', requiredOptionUids: ['w3', 'w2'] });
ok('乱序捷径不命中；按 w3 -> w2 顺序绕环后命中',
  ro.found === true && ro.depth === 5 &&
  ro.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 'a,b,c,b,c,t' &&
  ro.path.filter((n) => n.kind === 'option').map((n) => n.optionUid).join(',') === 'w-ab,w3,w-back,w2,w-go');

// 只允许乱序的剧情（w2 唯一可达、w3 在 w2 之后无法再取得 w2）=> 无解
const storyNoOrder = {
  startScene: 'a',
  variables: [],
  scenes: [
    { id: 'a', options: [{ uid: 'n2', text: '先到 b（必经 2）', target: 'b' }] },
    { id: 'b', options: [{ uid: 'n3', text: '再到 c（必经 1）', target: 'c' }] },
    { id: 'c', options: [{ uid: 'n-go', text: '终点', target: 't' }] },
    { id: 't', options: [] },
  ],
};
const rno = queryPath(storyNoOrder, { targetScene: 't', requiredOptionUids: ['n3', 'n2'] });
ok('物理上无法按指定顺序到达 => 无解，且最近状态（已完成 n3）未完成清单保留 n2 的顺序号 2',
  rno.found === false && rno.canAssertUnsolvable === true &&
  rno.remainingRequired.length === 1 &&
  rno.remainingRequired[0].order === 2 && rno.remainingRequired[0].uid === 'n2');

// 重复经过同一条必经选项只应推进一次（loop 场景）
const storyLoopReq = {
  startScene: 'a',
  variables: [],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'rl-loop', text: '打个转', target: 'a' },
        { uid: 'rl-go', text: '去终点', target: 'b' },
      ],
    },
    { id: 'b', options: [] },
  ],
};
const rlr = queryPath(storyLoopReq, { targetScene: 'b', requiredOptionUids: ['rl-loop'] });
ok('必经一次即可（循环中可重复经过）', rlr.found === true && rlr.depth === 2);

// 必经项 + 变量约束同时生效
const storyRC = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'rc-take', text: '拿钥匙再走', target: 'b', assigns: [{ variable: 'k', value: true }] },
      ],
    },
    { id: 'b', options: [{ uid: 'rc-go', text: '到 c', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const rrc = queryPath(storyRC, {
  targetScene: 'c',
  constraints: [{ variable: 'k', value: true }],
  requiredOptionUids: ['rc-take'],
});
ok('必经 + 变量约束同时命中', rrc.found === true && rrc.finalState.k === true && rrc.depth === 2);

// ---------- 禁用选项 ----------
console.log('禁用选项：');
// a->c 直路（禁用后不可用），只能 a->b->c
const storyF = {
  startScene: 'a',
  variables: [],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'f-short', text: '捷径（禁用）', target: 'c' },
        { uid: 'f-long', text: '绕路', target: 'b' },
      ],
    },
    { id: 'b', options: [{ uid: 'f-bc', text: '到 c', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const rf1 = queryPath(storyF, { targetScene: 'c', forbiddenOptionUids: ['f-short'] });
ok('禁用捷径后绕路命中', rf1.found === true && rf1.depth === 2);
ok('路径中不出现禁用选项',
  rf1.path.filter((n) => n.kind === 'option').every((n) => n.optionUid !== 'f-short'));
ok('结果回显禁用项解析信息',
  rf1.forbiddenOptions.length === 1 && rf1.forbiddenOptions[0].uid === 'f-short' &&
  rf1.forbiddenOptions[0].sceneId === 'a');

// 禁用唯一通路 => 目标不可达，回退状态不在目标场景
const rf2 = queryPath(storyF, { targetScene: 'c', forbiddenOptionUids: ['f-short', 'f-long'] });
ok('禁用全部出口后目标不可达',
  rf2.found === false && rf2.targetReachable === false && rf2.closest.sceneId === 'a');

// 必经 + 禁用同时给出：必经可达，但禁用项挡住必经时无解
const rf3 = queryPath(storyF, {
  targetScene: 'c',
  requiredOptionUids: ['f-bc'],
  forbiddenOptionUids: ['f-long'],
});
ok('禁用了通往必经项的唯一道路 => 无解', rf3.found === false);
ok('未完成必经项包含 f-bc', rf3.remainingRequired.some((x) => x.uid === 'f-bc'));

// ---------- 必经 / 禁用参数校验 ----------
console.log('必经 / 禁用参数校验：');
ok('必经 UID 不存在 => 400', throws400(
  () => queryPath(storyF, { targetScene: 'c', requiredOptionUids: ['nope'] }), /不存在/));
ok('禁用 UID 不存在 => 400', throws400(
  () => queryPath(storyF, { targetScene: 'c', forbiddenOptionUids: ['nope'] }), /不存在/));
ok('必经与禁用冲突 => 400', throws400(
  () => queryPath(storyF, {
    targetScene: 'c',
    requiredOptionUids: ['f-long'],
    forbiddenOptionUids: ['f-long'],
  }), /冲突/));
ok('必经列表内部重复 => 400', throws400(
  () => queryPath(storyF, { targetScene: 'c', requiredOptionUids: ['f-long', 'f-long'] }), /重复/));
ok('禁用列表内部重复 => 400', throws400(
  () => queryPath(storyF, { targetScene: 'c', forbiddenOptionUids: ['f-long', 'f-long'] }), /重复/));
ok('UID 列表非数组 => 400', throws400(
  () => queryPath(storyF, { targetScene: 'c', requiredOptionUids: 'f-long' }), /数组/));
ok('空 UID 项被忽略（等同于无必经）',
  queryPath(storyF, { targetScene: 'c', requiredOptionUids: ['', null] }).depth === 1);

// ---------- progress 去重：同一 (场景,状态) 在不同必经进度下分别入队 ----------
// 若错误地只按 场景+状态 去重，环路中“先到 b 但未经过必经”会挡住“经过必经后再到 b”的状态
const storyProg = {
  startScene: 'a',
  variables: [],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'p-ab', text: '去 b', target: 'b' },
        { uid: 'p-ax', text: '先去 x 经过必经', target: 'x' },
      ],
    },
    { id: 'b', options: [{ uid: 'p-bc', text: '到终点', target: 'c' }] },
    {
      id: 'x', options: [
        { uid: 'p-mark', text: '必经动作并回 a', target: 'a' },
      ],
    },
    { id: 'c', options: [] },
  ],
};
const rp = queryPath(storyProg, { targetScene: 'c', requiredOptionUids: ['p-mark'] });
ok('progress 纳入去重：绕环经过必经后仍能命中', rp.found === true && rp.depth === 4);
ok('progress 命中路径 a->x->a->b->c',
  rp.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId).join(',') === 'a,x,a,b,c');

// ---------- 截断 + 必经：未完成必经项随截断结果返回 ----------
const storyTr = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'tr-to-b', text: '去 b', target: 'b' },
        { uid: 'tr-mark', text: '必经（在不可达孤岛中）', target: 'zz' },
      ],
    },
    { id: 'b', options: [{ text: '到 c', target: 'c' }] },
    { id: 'c', options: [] },
    { id: 'zz', options: [] },
  ],
};
const rtr = queryPath(storyTr, {
  targetScene: 'c',
  requiredOptionUids: ['tr-mark'],
}, { maxStates: 1 });
ok('截断时 truncated=true 且不能断言无解', rtr.truncated === true && rtr.canAssertUnsolvable === false);
ok('截断结果返回未完成必经项', rtr.remainingRequired.length === 1 && rtr.remainingRequired[0].uid === 'tr-mark');
ok('截断提示文案含未完成计数', /未完成必经项 1\/1/.test(rtr.message));
ok('（对照）不存在的 UID 仍然 400', throws400(
  () => queryPath(story2, { targetScene: 'c', requiredOptionUids: ['ghost-uid-not-used'] }), /不存在/));

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  // 隔离数据目录，避免污染开发数据；禁用播种
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathquery-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SEED_ON_START = 'false';
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const post = (url, body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  try {
    // 草稿查询（不落盘）
    const q1 = await post('/api/pathquery', {
      story: story1,
      query: { targetScene: 'c', constraints: [{ variable: 'k', value: true }] },
    });
    ok('POST /api/pathquery 返回 200 且命中', q1.status === 200 && q1.body.found === true && q1.body.depth === 2);

    const q2 = await post('/api/pathquery', { story: story1, query: {} });
    ok('缺少目标场景返回 400', q2.status === 400 && /targetScene/.test(q2.body.error || ''));

    // 已保存剧情查询
    const created = await post('/api/stories', story1);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const q3 = await post(`/api/stories/${created.body.id}/pathquery`, {
      targetScene: 'c', constraints: [{ variable: 'k', value: true }],
    });
    ok('POST /api/stories/:id/pathquery 命中', q3.status === 200 && q3.body.found === true);
    const q4 = await post('/api/stories/no-such-id/pathquery', { targetScene: 'c' });
    ok('剧情不存在返回 404', q4.status === 404);
    const q5 = await post(`/api/stories/${created.body.id}/pathquery`, {
      targetScene: 'c', constraints: [{ variable: 'k', value: true }, { variable: 'k', value: false }],
    });
    ok('重复约束返回 400', q5.status === 400);

    // 有序必经 / 禁用选项（API 层校验）
    const storyUid = {
      startScene: 'a',
      scenes: [
        {
          id: 'a', options: [
            { uid: 's-direct', text: '直走', target: 'c' },
            { uid: 's-via', text: '绕路', target: 'b' },
          ],
        },
        { id: 'b', options: [{ uid: 's-bc', text: '到 c', target: 'c' }] },
        { id: 'c', options: [] },
      ],
    };
    const q6 = await post('/api/pathquery', {
      story: storyUid,
      query: { targetScene: 'c', requiredOptionUids: ['s-via', 's-bc'] },
    });
    ok('POST /api/pathquery 有序必经命中（2 步）',
      q6.status === 200 && q6.body.found === true && q6.body.depth === 2 &&
      q6.body.remainingRequired.length === 0);
    const q7 = await post('/api/pathquery', {
      story: storyUid,
      query: { targetScene: 'c', forbiddenOptionUids: ['s-direct'] },
    });
    ok('POST /api/pathquery 禁用捷径后绕路', q7.status === 200 && q7.body.depth === 2);
    const q8 = await post('/api/pathquery', {
      story: storyUid,
      query: { targetScene: 'c', requiredOptionUids: ['s-via'], forbiddenOptionUids: ['s-via'] },
    });
    ok('必经与禁用冲突返回 400', q8.status === 400 && /冲突/.test(q8.body.error || ''));
    const q9 = await post('/api/pathquery', {
      story: storyUid,
      query: { targetScene: 'c', requiredOptionUids: ['missing-uid'] },
    });
    ok('必经 UID 不存在返回 400', q9.status === 400 && /不存在/.test(q9.body.error || ''));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项路径查询断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
