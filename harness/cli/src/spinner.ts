/**
 * One-line activity spinner, rendered only on a TTY so piped runs stay clean.
 * @module @astra/cli/spinner
 */

import type { Theme } from './render.ts'

const FRAMES = ['✻', '✶', '✷', '✸', '✹', '✺', '✹', '✸', '✷', '✶']

export class Spinner {
  private readonly theme: Theme
  private timer: NodeJS.Timeout | undefined
  private frame = 0
  private started = 0
  private label = ''
  private visible = false

  constructor(theme: Theme) {
    this.theme = theme
  }

  /** Spinners need a terminal; pipes get silence instead of escape codes. */
  get enabled(): boolean {
    return process.stdout.isTTY === true
  }

  start(label: string): void {
    if (!this.enabled) return
    this.label = label
    if (this.timer === undefined) {
      this.started = Date.now()
      this.timer = setInterval(() => this.render(), 90)
      this.timer.unref()
    }
    this.render()
  }

  setLabel(label: string): void {
    this.label = label
    this.render()
  }

  /** Clear the line; safe to call before any other write. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.visible) {
      process.stdout.write('\r\u001B[2K')
      this.visible = false
    }
  }

  private render(): void {
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1)
    const frame = this.theme.cyan(FRAMES[this.frame++ % FRAMES.length])
    process.stdout.write(
      `\r\u001B[2K${frame} ${this.theme.gray(`${this.label}… ${elapsed}s · Esc / Ctrl+C 中断`)}`,
    )
    this.visible = true
  }
}
