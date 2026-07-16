const BASE = process.env.BOT_API_URL ?? ''
const KEY = process.env.BOT_API_KEY ?? ''

export interface BotResponse<T = unknown> {
  ok: boolean
  status: number
  data: T
}

function sanitizePath(path: string): string {
  if (!path.startsWith('/')) return '/'
  if (!path.startsWith('/api/')) return '/'
  return path
}

/** Appelle l'API du bot avec la clé x-api-key. Usage serveur uniquement. */
export async function botFetch<T = unknown>(path: string, init?: RequestInit): Promise<BotResponse<T>> {
  if (!BASE || !KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: 'Configuration BOT_API_URL/BOT_API_KEY manquante côté serveur' } as T,
    }
  }

  try {
    const safePath = sanitizePath(path)
    const target = new URL(safePath, BASE).toString()

    const res = await fetch(target, {
      ...(init ?? {}),
      headers: {
        'x-api-key': KEY,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) ?? {}),
      },
      cache: 'no-store',
    })

    const text = await res.text()
    let data: T

    try {
      data = JSON.parse(text ?? 'null') as T
    } catch {
      data = { raw: text ?? '' } as T
    }

    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    const err = e as Error
    return {
      ok: false,
      status: 502,
      data: { error: `API du bot injoignable: ${err?.message ?? 'erreur inconnue'}` } as T,
    }
  }
}
