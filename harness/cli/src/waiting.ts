/**
 * One-line waiting indicator, rendered only on a TTY so piped runs stay clean.
 * @module @astra/cli/waiting
 */

import { workingLine } from './render.ts'
import type { Theme } from './render.ts'

/** Waiting indicator: a bullet, the current activity and a running timer. */
export class Waiting {
  private readonly theme: Theme
  private timer: NodeJS.Timeout | undefined
  private started = 0
  private label = ''
  private visible = false

  constructor(theme: Theme) {
    this.theme = theme
  }

  /** The indicator needs a terminal; pipes get silence instead of escape codes. */
  get enabled(): boolean {
    return process.stdout.isTTY === true
  }

  start(label: string): void {
    if (!this.enabled) return
    this.label = label
    if (this.timer === undefined) {
      this.started = Date.now()
      this.timer = setInterval(() => this.render(), 1000)
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
    const elapsed = (Date.now() - this.started) / 1000
    process.stdout.write(`\r\u001B[2K${workingLine(this.theme, this.label, elapsed)}`)
    this.visible = true
  }
}
