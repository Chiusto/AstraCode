/**
 * Model discovery through the provider's `/models` endpoint.
 * Port of the listing part of `packages/llm/llm-deepseek/src/listing.ts`.
 * @module @astra/llm-deepseek/listing
 */

import { providerError } from './transport.ts'

/** Extract ordered model ids from a `/models` response. */
export function parseModelListing(raw: unknown): string[] {
  const data = typeof raw === 'object' && raw !== null && 'data' in raw ? raw.data : undefined
  if (!Array.isArray(data)) return []
  return data
    .map((item) => (typeof item === 'object' && item !== null && 'id' in item ? item.id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Request the provider's model listing; an empty list means the route does not publish one. */
export async function requestModelListing(
  connection: { baseUrl: string; apiKey: string },
  signal?: AbortSignal,
): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(`${connection.baseUrl}/models`, {
      headers: { authorization: `Bearer ${connection.apiKey}` },
      signal,
    })
  } catch {
    return []
  }
  if (!response.ok) throw providerError(await response.json().catch(() => ({})), response.status, response.headers)
  return parseModelListing(await response.json())
}
