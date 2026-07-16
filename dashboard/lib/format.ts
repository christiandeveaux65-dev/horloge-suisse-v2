const usdFmt = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const usdFmtPrecise = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6,
})

const numFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 })

export function toNum(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0')
  return Number.isFinite(n) ? n : 0
}

export function fmtUsd(v: any): string {
  const n = toNum(v)
  return Math.abs(n) > 0 && Math.abs(n) < 0.01 ? usdFmtPrecise.format(n) : usdFmt.format(n)
}

export function fmtNum(v: any): string {
  return numFmt.format(toNum(v))
}

export function fmtPct(v: any, digits = 2): string {
  const n = toNum(v)
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(digits)} %`
}

export function fmtDate(v: any): string {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  })
    .format(d)
    .replace(',', '')
}

export function fmtDateShort(v: any): string {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Paris',
  }).format(d)
}

export const CHAIN_LABELS: Record<string, string> = {
  arbitrum: 'Arbitrum',
  base: 'Base',
  optimism: 'Optimism',
}

export const CHAIN_COLORS: Record<string, string> = {
  arbitrum: '#38bdf8',
  base: '#2dd4a7',
  optimism: '#f87171',
}

export const CHART_COLORS = ['#2dd4a7', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#facc15', '#60B5FF', '#FF9149']

// Couleurs par token pour les pastilles visuelles
export const TOKEN_COLORS: Record<string, string> = {
  ETH: '#627eea',
  WETH: '#627eea',
  BTC: '#f7931a',
  WBTC: '#f7931a',
  cbBTC: '#f7931a',
  USDC: '#2775ca',
  USDT: '#26a17b',
  ARB: '#28a0f0',
  OP: '#ff0420',
  LINK: '#2a5ada',
  UNI: '#ff007a',
  PENDLE: '#1e90a6',
  GMX: '#2d55f0',
  AERO: '#0052ff',
}

export function tokenColor(sym?: string | null): string {
  return TOKEN_COLORS[(sym ?? '').trim()] ?? '#8b93b0'
}

// Format USD compact (1,2k$, 3,4M$)
const usdCompact = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})
export function fmtUsdCompact(v: any): string {
  const n = toNum(v)
  if (Math.abs(n) < 1000) return fmtUsd(n)
  return usdCompact.format(n)
}

// Variation en pourcentage entre deux valeurs
export function pctChange(from: any, to: any): number {
  const a = toNum(from)
  const b = toNum(to)
  if (a === 0) return 0
  return ((b - a) / Math.abs(a)) * 100
}

// Libellé de période lisible à partir d'un nombre d'heures
export function periodLabel(hours: number): string {
  if (hours <= 24) return `${hours} h`
  const d = Math.round(hours / 24)
  return `${d} jour${d > 1 ? 's' : ''}`
}
