import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireApiSession()
  if (denied) return denied
  const r = await botFetch('/api/backtest')
  return NextResponse.json(r?.data ?? [], { status: r?.status ?? 500 })
}

export async function POST(req: Request) {
  const denied = await requireApiSession()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const r = await botFetch('/api/backtest', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
  return NextResponse.json(r?.data ?? {}, { status: r?.status ?? 500 })
}
