import { NextResponse } from 'next/server'
import { botFetch } from '@/lib/bot-api'
import { requireApiSession } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function POST() {
  const denied = await requireApiSession()
  if (denied) return denied
  const r = await botFetch('/api/risk/resume', { method: 'POST' })
  return NextResponse.json(r?.data ?? {}, { status: r?.status ?? 500 })
}
