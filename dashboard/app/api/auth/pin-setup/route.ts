import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { PIN_CONFIG_KEY } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Création initiale du code PIN. Refuse la création si un PIN existe déjà.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const pin = String(body?.pin ?? '').trim()
  if (!/^\d{6}$/.test(pin)) {
    return NextResponse.json({ error: 'Le code PIN doit contenir exactement 6 chiffres.' }, { status: 400 })
  }
  const existing = await prisma.app_config.findUnique({ where: { key: PIN_CONFIG_KEY } })
  if (existing?.value) {
    return NextResponse.json({ error: 'Un code PIN est déjà configuré.' }, { status: 409 })
  }
  const hash = await bcrypt.hash(pin, 10)
  await prisma.app_config.upsert({
    where: { key: PIN_CONFIG_KEY },
    update: { value: hash },
    create: { key: PIN_CONFIG_KEY, value: hash },
  })
  return NextResponse.json({ ok: true })
}
