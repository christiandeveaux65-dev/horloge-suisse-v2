import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denied = await requireApiSession()
  if (denied) return denied
  const { search } = new URL(req.url)
  const r = await botFetch(`/api/trades${search ?? ''}`)
  return NextResponse.json(r?.data ?? {}, { status: r?.status ?? 500 })
}
