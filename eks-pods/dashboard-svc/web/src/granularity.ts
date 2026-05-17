// 매출 시계열 granularity 공용 헬퍼.
// 백엔드 /dashboard/sales/timeseries 의 bucket(ISO 문자열)을 granularity 별 x축 라벨로 변환.
import { type Granularity } from './api';

/** ISO bucket → 차트 x축 라벨. minute=HH:MM · hour=M/D HH시 · day=M/D */
export function formatBucket(iso: string, g: Granularity): string {
  // bucket 은 KST 기준 naive ISO (예: 2026-05-17T14:30:00). 슬라이스로 직접 파싱 — TZ 변환 회피.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, , mm, dd, hh, mi] = m;
  const md = `${parseInt(mm, 10)}/${parseInt(dd, 10)}`;
  if (g === 'minute') return `${hh}:${mi}`;
  if (g === 'hour') return `${md} ${parseInt(hh, 10)}시`;
  return md;
}

/** granularity 별 차트 부제 라벨. */
export function grainCaption(g: Granularity): string {
  if (g === 'minute') return '분 단위 · 최근 6시간';
  if (g === 'hour') return '시간 단위 · 최근 7일';
  return '일 단위 · 최근 30일';
}
