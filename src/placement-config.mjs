import Schema from '@deepseek-ai/schemastery';

// This is Canvas search policy, never an engine fact or compiler/safety profile.
export const Config = Schema.object({
  placement: Schema.object({
    frontGapCells: Schema.number().min(0).step(1).default(2).description(
      '前方间隔（默认 2 格）：范围为本插件所有已绑定世界的放置搜索。保存并重载插件后生效；0 关闭间隔，大于 0 留出相应格数。'),
    forwardSearchCells: Schema.number().min(0).step(1).default(16).description(
      '前向搜索距离（默认 16 格）：范围为本插件所有已绑定世界的放置搜索。保存并重载插件后生效；0 关闭前向扩展，大于 0 在相应距离内寻找位置。'),
    lateralSearchCells: Schema.number().min(0).step(1).default(8).description(
      '侧向搜索距离（默认 8 格）：范围为本插件所有已绑定世界的放置搜索。保存并重载插件后生效；0 关闭侧向扩展，大于 0 允许相应侧向偏移。'),
    verticalSearchCells: Schema.number().min(0).step(1).default(4).description(
      '竖向搜索距离（默认 4 格）：范围为本插件所有已绑定世界的放置搜索。保存并重载插件后生效；0 关闭竖向扩展，大于 0 允许相应竖向偏移。'),
  }).description('放置搜索设置：仅控制候选位置搜索；0 不会关闭世界源保护、身体检查或可回滚事务。'),
});
