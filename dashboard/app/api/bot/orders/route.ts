import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireApiSession()
  if (denied) return denied
  const r = await botFetch('/api/orders')
  return NextResponse.json(r?.data ?? [], { status: r?.status ?? 500 })
}

export async function POST(req: Request) {
  const denied = await requireApiSession()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const kind = body?.kind ?? 'twap'
  const path = kind === 'limit' ? '/api/orders/limit' : '/api/orders/twap'
  const { kind: _k, ...payload } = body ?? {}
  const r = await botFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  })
  return NextResponse.json(r?.data ?? {}, { status: r?.status ?? 500 })
}
