/**
 * Ordered system-prompt sections. Port of the assembly core of
 * `packages/core/system-prompt/src/index.ts` without the cordis registry.
 * @module @astra/system-prompt
 */

/** One contributed section of the system prompt. */
export interface PromptSection {
  /** Unique name; a duplicate registration throws. */
  readonly name: string
  /** Sections are concatenated in ascending order; equal orders use name order. */
  readonly order: number
  /** Static text or a provider evaluated at each assembly. */
  readonly text: string | (() => string)
}

/** One section of an assembly with its text resolved. */
export interface AssembledSection {
  name: string
  text: string
}

/** Resolve and order sections; empty sections contribute nothing. */
export function assembleSystemPrompt(sections: readonly PromptSection[]): AssembledSection[] {
  const names = new Set<string>()
  return sections
    .map((section) => {
      if (names.has(section.name)) throw new Error(`duplicate system-prompt section "${section.name}"`)
      names.add(section.name)
      return { name: section.name, order: section.order, text: (typeof section.text === 'function' ? section.text() : section.text).trim() }
    })
    .sort((left, right) => left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .filter((section) => section.text.length > 0)
    .map(({ name, text }) => ({ name, text }))
}

/** Join assembled sections with one blank line between neighbours. */
export function renderPrompt(sections: readonly AssembledSection[]): string {
  return sections.map((section) => section.text).join('\n\n')
}
