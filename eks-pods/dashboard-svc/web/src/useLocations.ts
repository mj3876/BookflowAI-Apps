import { useQuery } from '@tanstack/react-query';
import { fetchLocations, type LocationItem, type Role } from './api';

/**
 * UX-9 location 마스터 hook — 모든 페이지에서 한 번만 fetch.
 * 5분 staleTime · 변동 적음 (영업 일과 location 추가 거의 없음).
 *
 * 반환:
 *   items   : 원본 array
 *   byId    : Map<location_id, LocationItem>
 *   nameOf  : (id) => '강남점' 같은 표시용 이름 ('매장 N' fallback)
 *   labelOf : (id) => '강남점 (수도권 매장)' 같은 풀 라벨
 */
export function useLocations(role: Role) {
  const q = useQuery({
    queryKey: ['locations', role],
    queryFn: () => fetchLocations(role),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const items = q.data?.items ?? [];
  const byId = new Map<number, LocationItem>(items.map((i) => [i.location_id, i]));

  const nameOf = (id: number | null | undefined): string => {
    if (id == null) return '-';
    const it = byId.get(id);
    return it?.name ?? `매장 ${id}`;
  };

  const labelOf = (id: number | null | undefined): string => {
    if (id == null) return '-';
    const it = byId.get(id);
    if (!it) return `매장 ${id}`;
    const wh = it.wh_id === 1 ? '수도권' : it.wh_id === 2 ? '영남' : '';
    if (it.location_type === 'WH') return `${it.name ?? `위치 ${id}`} (${wh} 거점창고)`;
    if (it.location_type === 'STORE_ONLINE') return `${it.name ?? `위치 ${id}`} (${wh} 온라인)`;
    return `${it.name ?? `매장 ${id}`} (${wh})`;
  };

  return { items, byId, nameOf, labelOf, isLoading: q.isLoading };
}
