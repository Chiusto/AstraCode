/**
 * Output retention for tool bodies: a byte budget with a standardized notice.
 * @module @astra/tools/presentation
 */

import { TextRetainer, formatRetentionNotice } from '../../../util/output-retention/src/index.ts'
import type { RetentionNotice } from '../../../util/output-retention/src/index.ts'

/** Per-stream byte budget of `run_terminal` output: a stable head and tail. */
export const TERMINAL_OUTPUT_BYTES = { headBytes: 32_768, tailBytes: 8_192 } as const

/** Keep a prefix and a suffix of `text`, replacing the omitted middle with one notice line. */
export function retainText(
  text: string,
  strategy: { headBytes: number; tailBytes: number },
  recovery: string,
): string {
  if (Buffer.byteLength(text, 'utf8') <= strategy.headBytes + strategy.tailBytes) return text
  const retainer = new TextRetainer({ kind: 'headTail', ...strategy })
  retainer.push(text)
  const kept = retainer.finish()
  const notice: RetentionNotice = {
    scope: 'output',
    strategy: 'headTail',
    unit: 'bytes',
    limit: strategy,
    kept: Buffer.byteLength(kept.text, 'utf8'),
    omitted: kept.omittedBytes,
  }
  const footer = formatRetentionNotice(notice, () => recovery)
  return `${kept.text}\n\n[… ${footer} …]\n\n`
}
