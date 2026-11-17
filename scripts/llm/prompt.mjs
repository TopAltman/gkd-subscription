/**
 * LLM 提示词模板
 *
 * 与 server/server.mjs 中的 SYSTEM_PROMPT 保持同步。
 * 单独抽出来是为了方便在不启动服务的情况下调参、对比不同模型的表现。
 */

export const SYSTEM_PROMPT = `你是 Android 无障碍自动化规则专家。你的任务是根据一个 App 界面的节点树，生成用于点击"跳过广告"按钮的 GKD 选择器。

GKD 选择器语法要点：
- 属性选择器形如 [text="跳过"]、[id="com.x:id/y"]、[desc="关闭广告"]、[clickable=true]
- 支持运算符 = != ^= *= $= ~=（正则，Kotlin 语法，正则要转义）
- 支持 && || ! 逻辑组合，&& 优先级更高
- 关系操作符：> 祖先、< 直接子、+ 前置兄弟、- 后置兄弟、<< 深度先序子孙
- 属性选择器与关系操作符之间必须有空格
- 匹配方向是从右往左，末尾的选择器是起点
- @ 前缀表示目标节点是匹配到的第一个而非最后一个

输出要求：
1. 只输出 JSON，不要任何解释文字或 markdown 代码块
2. 格式：{"candidates":[{"matches":"<选择器>","note":"<一句话说明>"}]}
3. 给出 2-4 个候选，策略各不相同：
   - 优先用稳定的 id（如果存在）
   - 其次用精确文案 text
   - 再次用文案+父容器组合（防止误伤）
   - 最后一个用宽松的纯文案匹配（作为兜底）
4. 选择器必须尽可能精确，宁可漏跳也不能误触到别的按钮
5. 不要用坐标类选择器
6. 如果节点树里没有明确的跳过按钮，返回 {"candidates":[]}`;

/**
 * 构建用户提示词。
 * @param {object} report  { appId, activityId, leakCandidates, tree }
 */
export function buildUserPrompt(report) {
  const tree = JSON.stringify(report.tree, null, 1);
  return `App 包名: ${report.appId}
Activity: ${report.activityId ?? '未知'}
检测到的跳过候选节点:
${JSON.stringify(report.leakCandidates ?? [], null, 1)}

节点树:
${tree}

请生成 2-4 个候选选择器。`;
}

/**
 * 不同候选策略的说明，供调试时对照模型输出。
 *
 * 期望模型给出的候选大致覆盖以下几类（按稳健度从高到低）：
 *  1. id 精确匹配        [id="com.x:id/skip_btn"]
 *  2. 文案 + 类名         TextView[text="跳过"]
 *  3. 文案 + 父容器约束   [text="跳过"] > [text*="广告"]
 *  4. 纯文案兜底          [text*="跳过"]
 *
 * 第 4 类误触风险最高，校验器的负样本检查会优先淘汰它。
 */
export const CANDIDATE_STRATEGIES = [
  { name: 'id-exact', desc: '控件 id 精确匹配，最稳健' },
  { name: 'text-class', desc: '文案 + 类名，兼顾稳健与泛化' },
  { name: 'text-parent', desc: '文案 + 父容器约束，防误伤' },
  { name: 'text-loose', desc: '纯文案兜底，误触风险高' },
];
