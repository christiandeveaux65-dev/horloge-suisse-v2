export const fetcher = async (url: string): Promise<any> => {
  const res = await fetch(url, { cache: 'no-store' })
  const text = await res.text()

  let body: unknown = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { error: text || `Erreur ${res.status}` }
  }

  if (!res.ok) {
    const maybeError = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error?: unknown }).error ?? `Erreur ${res.status}`)
      : `Erreur ${res.status}`
    throw new Error(maybeError)
  }

  return body
}
