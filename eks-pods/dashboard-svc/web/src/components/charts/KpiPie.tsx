/**
 * KpiPie — pie / donut chart bf-theme.
 *
 * 입력 형식 두 가지 (호환):
 *  - data: { name, value }[]  (default — nameKey/valueKey 생략)
 *  - data: T[] + nameKey/valueKey  (임의 필드)
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

const BF_COLORS = ['#3B82F6', '#F97316', '#22C55E', '#A855F7', '#EC4899', '#14B8A6', '#EAB308', '#0EA5E9'];
const TOKENS = { text: '#212529', muted: '#6C757D', border: '#DEE2E6' };

type Props = {
  data: Array<Record<string, unknown>>;
  /** 필드명 (default 'name') — 임의 객체 array 에서 표시명 추출 */
  nameKey?: string;
  /** 필드명 (default 'value') — 임의 객체 array 에서 수치 추출 */
  valueKey?: string;
  title?: string;
  height?: number;
  donut?: boolean;
  isLoading?: boolean;
};

export default function KpiPie({
  data,
  nameKey = 'name',
  valueKey = 'value',
  title,
  height = 300,
  donut = true,
  isLoading,
}: Props) {
  const series = useMemo(
    () => data.map((d) => ({ name: String(d[nameKey] ?? ''), value: Number(d[valueKey] ?? 0) })),
    [data, nameKey, valueKey],
  );
  const option = useMemo(
    () => ({
      title: title
        ? { text: title, textStyle: { color: TOKENS.text, fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: {
        trigger: 'item',
        backgroundColor: '#FFFFFF',
        borderColor: TOKENS.border,
        textStyle: { color: TOKENS.text, fontSize: 11 },
        formatter: '{b}<br/>{c} ({d}%)',
      },
      legend: {
        orient: 'vertical',
        right: 8,
        top: 'middle',
        textStyle: { color: TOKENS.muted, fontSize: 11 },
        type: 'scroll',
      },
      color: BF_COLORS,
      series: [
        {
          type: 'pie',
          radius: donut ? ['45%', '70%'] : '70%',
          center: ['40%', '52%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#FFFFFF', borderWidth: 2 },
          label: { color: TOKENS.muted, fontSize: 10 },
          labelLine: { lineStyle: { color: TOKENS.border } },
          data: series,
        },
      ],
    }),
    [series, title, donut],
  );

  if (isLoading) {
    return (
      <div
        className="rounded bg-bf-panel2 border border-bf-border2 animate-pulse"
        style={{ height }}
      />
    );
  }
  if (data.length === 0) {
    return (
      <div
        className="rounded bg-bf-panel2 border border-bf-border2 flex items-center justify-center text-bf-muted text-xs"
        style={{ height }}
      >
        데이터 없음
      </div>
    );
  }

  return <ReactECharts option={option} style={{ height }} opts={{ renderer: 'svg' }} />;
}
