import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { PIN_CONFIG_KEY } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Indique si un code PIN a déjà été configuré (public, utilisé par l'écran de connexion).
export async function GET() {
  try {
    const cfg = await prisma.app_config.findUnique({ where: { key: PIN_CONFIG_KEY } })
    return NextResponse.json({ configured: !!cfg?.value })
  } catch {
    return NextResponse.json({ configured: false })
  }
}
