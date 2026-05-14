/**
 * KpiBar — bar chart (vertical · horizontal · stacked) bf-theme.
 *
 * data 형식 두 가지:
 *  1) [{ name, value }] — 단일 series (default)
 *  2) [{ name, foo, bar, baz }] + yKey=['foo','bar','baz'] — 다중 series (stacked 가능)
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

const BF_COLORS = ['#3B82F6', '#F97316', '#22C55E', '#A855F7', '#EC4899', '#14B8A6', '#EAB308', '#0EA5E9'];
const TOKENS = { text: '#212529', muted: '#6C757D', border: '#DEE2E6', split: '#E9ECEF' };

type Props<T> = {
  data: T[];
  xKey?: keyof T;       // category 축 key (default 'name')
  yKey?: keyof T | (keyof T)[]; // value key(s) (default 'value')
  title?: string;
  height?: number;
  horizontal?: boolean; // y 축이 category (default false)
  stacked?: boolean;    // 다중 yKey 일 때 stack (default false)
  yLabels?: string[];   // 다중 series legend
  color?: string;       // 단일 series 색 override
  isLoading?: boolean;
};

export default function KpiBar<T extends Record<string, unknown>>({
  data,
  xKey,
  yKey,
  title,
  height = 300,
  horizontal = false,
  stacked = false,
  yLabels,
  color,
  isLoading,
}: Props<T>) {
  const xK = (xKey ?? 'name') as keyof T;
  const yKeys = Array.isArray(yKey ?? 'value')
    ? (yKey as (keyof T)[])
    : [(yKey ?? 'value') as keyof T];
  const labels = yLabels ?? yKeys.map(String);

  const option = useMemo(() => {
    const categories = data.map((d) => d[xK]);
    const catAxis = {
      type: 'category' as const,
      data: categories,
      axisLine: { lineStyle: { color: TOKENS.border } },
      axisLabel: { color: TOKENS.muted, fontSize: 10, interval: 0, rotate: horizontal ? 0 : 30 },
    };
    const valAxis = {
      type: 'value' as const,
      axisLine: { lineStyle: { color: TOKENS.border } },
      axisLabel: { color: TOKENS.muted, fontSize: 10 },
      splitLine: { lineStyle: { color: TOKENS.split } },
    };

    return {
      title: title
        ? { text: title, textStyle: { color: TOKENS.text, fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: '#FFFFFF',
        borderColor: TOKENS.border,
        textStyle: { color: TOKENS.text, fontSize: 11 },
      },
      legend:
        yKeys.length > 1
          ? { data: labels, textStyle: { color: TOKENS.muted, fontSize: 11 }, top: title ? 26 : 4 }
          : undefined,
      grid: {
        left: horizontal ? 110 : 50,
        right: 20,
        top: title ? 56 : 28,
        bottom: horizontal ? 30 : 50,
      },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      series: yKeys.map((k, i) => ({
        name: labels[i],
        type: 'bar',
        stack: stacked ? 'total' : undefined,
        itemStyle: {
          color: yKeys.length === 1 && color ? color : BF_COLORS[i % BF_COLORS.length],
          borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        data: data.map((d) => d[k]),
        barMaxWidth: 32,
      })),
    };
  }, [data, xK, yKeys, title, horizontal, stacked, yLabels, color, labels]);

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
