'use client'

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts'

interface Props {
  data: Record<string, any>[]
  series: { key: string; color: string; label?: string }[]
  height?: number
  yFormatter?: (v: any) => string
}

export default function MultiLine({ data, series, height = 320, yFormatter }: Props) {
  return (
    <div style={{ width: '100%', height }} role="img" aria-label="Graphique multi-séries">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data ?? []} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <XAxis dataKey="label" tickLine={false} tick={{ fontSize: 10 }} interval="preserveStartEnd" stroke="#3f4356" />
          <YAxis
            tickLine={false}
            tick={{ fontSize: 10 }}
            stroke="#3f4356"
            domain={['auto', 'auto']}
            tickFormatter={yFormatter ?? ((v: any) => `${v}`)}
            width={72}
          />
          <Tooltip contentStyle={{ backgroundColor: '#11131a', border: '1px solid #262a3b', borderRadius: 8, fontSize: 11 }} />
          <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
          {(series ?? []).map((s) => (
            <Line
              key={s?.key}
              type="monotone"
              dataKey={s?.key}
              name={s?.label ?? s?.key}
              stroke={s?.color ?? '#2dd4a7'}
              strokeWidth={2}
              dot={false}
              animationDuration={800}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
