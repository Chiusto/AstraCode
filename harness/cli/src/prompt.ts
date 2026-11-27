/**
 * The system prompt this shell sends: ordered sections assembled per request.
 * @module @astra/cli/prompt
 */

import { assembleSystemPrompt, renderPrompt } from '../../packages/core/system-prompt/src/index.ts'
import type { PromptSection } from '../../packages/core/system-prompt/src/index.ts'
import type { ToolDefinition } from '../../packages/core/tools/src/index.ts'
import type { CliConfig } from './config.ts'

/** Build the prompt from live config values, so `/cd` and `/model` apply at once. */
export function createSystemPrompt(config: CliConfig, tools: readonly ToolDefinition[]): () => string {
  const sections: PromptSection[] = [
    { name: 'role', order: 10, text: '你是 Astra，一个运行在用户终端里的编程助手。' },
    {
      name: 'environment',
      order: 20,
      text: () => [
        '环境',
        `- 工作目录：${config.cwd}`,
        `- 平台：${process.platform}，Node ${process.versions.node}`,
        `- 模型：${config.model}`,
        `- 可用工具：${tools.map((tool) => tool.name).join('、')}`,
      ].join('\n'),
    },
    {
      name: 'working-style',
      order: 30,
      text: [
        '工作方式',
        '- 需要查看代码、目录或运行命令时，直接调用工具，不要凭空猜测内容。',
        '- 修改文件前先用 read_file 确认原文；小范围改动用 edit_file，整文件重写才用 write_file。',
        '- 一次调用只做一件事；命令保持简短，不要运行需要交互输入的程序。',
        '- 工具失败时先读错误信息再决定下一步，不要重复同样的失败调用。',
      ].join('\n'),
    },
    {
      name: 'output',
      order: 40,
      text: [
        '输出',
        '- 用中文回答，先给结论再给细节。',
        '- 不要复述工具已经打印过的输出，只说明关键结论。',
        '- 代码块标注语言；提到文件时用相对工作目录的路径。',
      ].join('\n'),
    },
    { name: 'extra', order: 50, text: () => config.systemExtra ?? '' },
  ]
  return () => renderPrompt(assembleSystemPrompt(sections))
}
