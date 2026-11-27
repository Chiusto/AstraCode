/**
 * Hidden input for API keys: raw-mode echo of `*`, falling back to a normal
 * readline question when stdin is not a terminal.
 * @module @astra/cli/secret
 */

import type * as readline from 'node:readline'

export function readSecret(rl: readline.Interface, question: string): Promise<string> {
  const stdin = process.stdin
  if (stdin.isTTY !== true) {
    return new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()))
    })
  }

  process.stdout.write(question)
  let wasRaw = false
  try {
    wasRaw = stdin.isRaw === true
    stdin.setRawMode(true)
  } catch {
    return new Promise((resolve) => {
      rl.question('', (answer) => resolve(answer.trim()))
    })
  }
  stdin.resume()
  rl.pause()

  return new Promise((resolve) => {
    let value = ''
    let settled = false

    const cleanup = (): void => {
      if (settled) return
      settled = true
      stdin.removeListener('data', onData)
      try {
        stdin.setRawMode(wasRaw)
      } catch {
        // The terminal may already be gone.
      }
      rl.resume()
    }

    const finish = (result: string): void => {
      cleanup()
      process.stdout.write('\n')
      resolve(result)
    }

    const onData = (buffer: Buffer): void => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') {
          finish('')
          return
        }
        if (char === '\r' || char === '\n') {
          finish(value)
          return
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (char >= ' ') {
          value += char
          process.stdout.write('*')
        }
      }
    }

    stdin.on('data', onData)
  })
}
