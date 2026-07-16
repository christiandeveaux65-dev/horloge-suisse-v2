'use client'

import { ResponsiveContainer, AreaChart, Area, YAxis } from 'recharts'

interface Props {
  data: { v: number }[]
  color?: string
  height?: number
}

export default function Sparkline({ data, color = '#2dd4a7', height = 40 }: Props) {
  const rows = data ?? []
  const id = `spark-${color.replace('#', '')}`
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#${id})`} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
