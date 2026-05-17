/**
 * KpiLine — line/area chart (bf-theme · 다중 line 지원).
 *
 * yKey 가 array 면 series 가 여러 개 그려진다. yLabels 로 legend 표기.
 */
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

const BF_COLORS = ['#3B82F6', '#F97316', '#22C55E', '#A855F7', '#EC4899', '#14B8A6', '#EAB308', '#0EA5E9'];
const TOKENS = { text: '#212529', muted: '#6C757D', border: '#DEE2E6', split: '#E9ECEF' };

type Props<T> = {
  data: T[];
  xKey: keyof T;
  yKey: keyof T | (keyof T)[];
  title?: string;
  height?: number;
  smooth?: boolean;
  area?: boolean;
  yLabels?: string[];
  /** 2번째 series 를 보조(우측) Y축에 — 매출↔건수처럼 스케일 차이 큰 경우 */
  dualAxis?: boolean;
  isLoading?: boolean;
};

export default function KpiLine<T extends Record<string, unknown>>({
  data,
  xKey,
  yKey,
  title,
  height = 300,
  smooth = true,
  area = false,
  yLabels,
  dualAxis = false,
  isLoading,
}: Props<T>) {
  const yKeys = Array.isArray(yKey) ? yKey : [yKey];
  const labels = yLabels ?? yKeys.map(String);
  const useDual = dualAxis && yKeys.length >= 2;

  const option = useMemo(
    () => ({
      title: title
        ? { text: title, textStyle: { color: TOKENS.text, fontSize: 13, fontWeight: 600 } }
        : undefined,
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#FFFFFF',
        borderColor: TOKENS.border,
        textStyle: { color: TOKENS.text, fontSize: 11 },
      },
      legend:
        yKeys.length > 1
          ? { data: labels, textStyle: { color: TOKENS.muted, fontSize: 11 }, top: title ? 26 : 4 }
          : undefined,
      grid: { left: 50, right: useDual ? 56 : 20, top: title ? 56 : 28, bottom: 30 },
      xAxis: {
        type: 'category',
        data: data.map((d) => d[xKey]),
        axisLine: { lineStyle: { color: TOKENS.border } },
        axisLabel: { color: TOKENS.muted, fontSize: 10 },
      },
      yAxis: useDual
        ? [
            {
              type: 'value', name: labels[0], position: 'left',
              nameTextStyle: { color: TOKENS.muted, fontSize: 10 },
              axisLine: { lineStyle: { color: TOKENS.border } },
              axisLabel: { color: TOKENS.muted, fontSize: 10 },
              splitLine: { lineStyle: { color: TOKENS.split } },
            },
            {
              type: 'value', name: labels[1], position: 'right',
              nameTextStyle: { color: TOKENS.muted, fontSize: 10 },
              axisLine: { lineStyle: { color: TOKENS.border } },
              axisLabel: { color: TOKENS.muted, fontSize: 10 },
              splitLine: { show: false },
            },
          ]
        : {
            type: 'value',
            axisLine: { lineStyle: { color: TOKENS.border } },
            axisLabel: { color: TOKENS.muted, fontSize: 10 },
            splitLine: { lineStyle: { color: TOKENS.split } },
          },
      series: yKeys.map((k, i) => ({
        name: labels[i],
        type: 'line',
        yAxisIndex: useDual && i === 1 ? 1 : 0,
        smooth,
        areaStyle: area ? { color: BF_COLORS[i % BF_COLORS.length], opacity: 0.18 } : undefined,
        lineStyle: { color: BF_COLORS[i % BF_COLORS.length], width: 2 },
        itemStyle: { color: BF_COLORS[i % BF_COLORS.length] },
        symbol: 'circle',
        symbolSize: 5,
        data: data.map((d) => d[k]),
      })),
    }),
    [data, xKey, yKey, title, smooth, area, yLabels, useDual],
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
