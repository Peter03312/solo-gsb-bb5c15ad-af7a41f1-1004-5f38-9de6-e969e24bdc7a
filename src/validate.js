'use strict';
/**
 * 执行单校验：编号重复、缺失引用（前置不存在）、自依赖、循环依赖。
 * 输入为提示数组 [{ label, type, description, deps: [label...] }]，返回错误字符串数组。
 */

const CUE_TYPES = ['light', 'sound', 'set', 'other'];

function validateCues(cues) {
  const errors = [];

  if (!Array.isArray(cues) || cues.length === 0) {
    errors.push('执行单为空：至少需要一条提示');
    return errors;
  }

  const byLabel = new Map();
  cues.forEach((c, i) => {
    const pos = `第 ${i + 1} 条`;
    if (!c.label) {
      errors.push(`${pos}：提示编号不能为空`);
    } else if (byLabel.has(c.label)) {
      errors.push(`提示编号重复：「${c.label}」`);
    } else {
      byLabel.set(c.label, c);
    }
    if (!CUE_TYPES.includes(c.type)) {
      errors.push(`${pos}（${c.label || '未命名'}）：类型无效，应为 light/sound/set/other`);
    }
  });

  // 缺失引用 / 自依赖
  for (const c of cues) {
    if (!c.label) continue;
    for (const dep of c.deps) {
      if (dep === c.label) {
        errors.push(`提示「${c.label}」不能依赖自身`);
      } else if (!byLabel.has(dep)) {
        errors.push(`提示「${c.label}」的前置「${dep}」不存在（缺失引用）`);
      }
    }
  }

  // 循环依赖：DFS 找环并给出路径
  const state = new Map(); // 1=在栈中 2=已完成
  const stack = [];
  const seenCycles = new Set();

  function dfs(label) {
    state.set(label, 1);
    stack.push(label);
    for (const dep of byLabel.get(label).deps) {
      if (!byLabel.has(dep) || dep === label) continue;
      const s = state.get(dep) || 0;
      if (s === 0) {
        dfs(dep);
      } else if (s === 1) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = cycle.join('→');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          errors.push(`检测到循环依赖：${cycle.join(' → ')}`);
        }
      }
    }
    stack.pop();
    state.set(label, 2);
  }

  for (const label of byLabel.keys()) {
    if (!(state.get(label) || 0)) dfs(label);
  }

  return errors;
}

module.exports = { validateCues, CUE_TYPES };
