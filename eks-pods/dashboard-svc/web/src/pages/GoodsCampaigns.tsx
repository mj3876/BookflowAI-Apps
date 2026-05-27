import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  deleteGoodsCampaign,
  fetchBooks,
  fetchGoodsCampaign,
  fetchGoodsCampaigns,
  fetchLocations,
  patchGoodsRecommendation,
  postGoodsCampaign,
  postGoodsCampaignRecommend,
  postGoodsCampaignSend,
  type GoodsCampaign,
  type GoodsRecommendation,
  type Role,
} from '../api';
import { roleGroup } from '../auth';

const today = new Date().toISOString().slice(0, 10);

function plusDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function GoodsCampaigns() {
  const { role } = useOutletContext<{ role: Role }>();
  const isHQ = roleGroup(role) === 'HQ';
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('주말 굿즈 진열 이벤트');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(plusDays(7));
  const [objective, setObjective] = useState('단기 이벤트 기간 동안 선정 도서 굿즈 부가 구매 증대');
  const [isbnInput, setIsbnInput] = useState('');
  const [branchInput, setBranchInput] = useState('1,2,3');
  const [editing, setEditing] = useState<GoodsRecommendation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const campaigns = useQuery({
    queryKey: ['goods-campaigns', role],
    queryFn: () => fetchGoodsCampaigns(role),
    enabled: isHQ,
  });

  const selected = useQuery({
    queryKey: ['goods-campaign', selectedId, role],
    queryFn: () => fetchGoodsCampaign(role, selectedId!),
    enabled: isHQ && !!selectedId,
  });

  const books = useQuery({
    queryKey: ['goods-books', role],
    queryFn: () => fetchBooks(role, { limit: 20, status: 'ACTIVE' }),
    enabled: isHQ,
    staleTime: 60_000,
  });

  const locations = useQuery({
    queryKey: ['goods-locations', role],
    queryFn: () => fetchLocations(role),
    enabled: isHQ,
    staleTime: 60_000,
  });

  const branchOptions = useMemo(
    () => (locations.data?.items ?? []).filter((l) => l.location_type !== 'WH' && !l.is_virtual),
    [locations.data?.items],
  );

  const create = useMutation({
    mutationFn: async () => {
      const isbn13s = isbnInput.split(',').map((v) => v.trim()).filter(Boolean);
      const target_branch_ids = branchInput.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
      if (!isbn13s.length) throw new Error('Select at least one ISBN.');
      if (!target_branch_ids.length) throw new Error('Select at least one branch.');
      return postGoodsCampaign(role, {
        title,
        campaign_type: 'EVENT',
        start_date: startDate,
        end_date: endDate,
        isbn13s,
        target_branch_ids,
        objective,
      });
    },
    onSuccess: (data) => {
      setSelectedId(data.campaign_id);
      qc.invalidateQueries({ queryKey: ['goods-campaigns'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '캠페인 생성에 실패했습니다.'),
  });

  const recommend = useMutation({
    mutationFn: (campaign: GoodsCampaign) => postGoodsCampaignRecommend(role, campaign.campaign_id, 'auto'),
    onSuccess: (_, campaign) => {
      qc.invalidateQueries({ queryKey: ['goods-campaign', campaign.campaign_id] });
      qc.invalidateQueries({ queryKey: ['goods-campaigns'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'AI 추천 생성에 실패했습니다.'),
  });

  const send = useMutation({
    mutationFn: (campaign: GoodsCampaign) => postGoodsCampaignSend(role, campaign.campaign_id),
    onSuccess: (_, campaign) => {
      qc.invalidateQueries({ queryKey: ['goods-campaign', campaign.campaign_id] });
      qc.invalidateQueries({ queryKey: ['goods-campaigns'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '메일 발송에 실패했습니다.'),
  });

  const deleteCampaign = useMutation({
    mutationFn: (campaign: GoodsCampaign) => {
      if (!window.confirm(`"${campaign.title}" 캠페인을 삭제하시겠습니까?`)) throw new Error('cancelled');
      return deleteGoodsCampaign(role, campaign.campaign_id);
    },
    onSuccess: (_, campaign) => {
      if (selectedId === campaign.campaign_id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['goods-campaigns'] });
    },
    onError: (e) => { if ((e as Error).message !== 'cancelled') setError((e as Error).message || '캠페인 삭제에 실패했습니다.'); },
  });

  const saveEdit = useMutation({
    mutationFn: (rec: GoodsRecommendation) => patchGoodsRecommendation(role, rec.campaign_id, {
      recommendation_id: rec.recommendation_id,
      recommended_goods: rec.recommended_goods,
      display_position: rec.display_position ?? undefined,
      reason: rec.reason ?? undefined,
      priority: rec.priority,
      email_subject: rec.email_subject ?? undefined,
      email_body: rec.email_body ?? undefined,
    }),
    onSuccess: (rec) => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['goods-campaign', rec.campaign_id] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '저장에 실패했습니다.'),
  });

  if (!isHQ) {
    return <div className="card text-sm text-bf-muted">본사 관리자(HQ) 권한이 필요합니다.</div>;
  }

  const activeCampaign = selected.data;
  const recommendations = activeCampaign?.recommendations ?? [];
  const recSource = recommendations[0]?.source ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">굿즈 이벤트 캠페인</h1>
          <p className="text-bf-muted text-xs mt-1">
            지점 단기 진열 이벤트를 위한 Gemini AI 추천. 재고 수량은 변경되지 않습니다.
          </p>
        </div>
        {error && <button className="btn-ghost text-bf-danger" onClick={() => setError(null)}>{error}</button>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-4">
        <section className="card flex flex-col gap-3">
          <h2 className="h2">캠페인 생성</h2>
          <label className="text-[11px] text-bf-muted">캠페인 제목</label>
          <input className="ipt" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-bf-muted">시작일</label>
              <input className="ipt w-full" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-bf-muted">종료일</label>
              <input className="ipt w-full" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <label className="text-[11px] text-bf-muted">ISBN13 (쉼표 구분)</label>
          <input
            className="ipt font-mono"
            placeholder="978...,978..."
            value={isbnInput}
            onChange={(e) => setIsbnInput(e.target.value)}
          />
          <div className="flex gap-2 flex-wrap">
            {(books.data?.items ?? []).slice(0, 6).map((b) => (
              <button
                key={b.isbn13}
                type="button"
                className="btn-ghost btn-sm"
                title={b.title}
                onClick={() => setIsbnInput((prev) => prev ? `${prev},${b.isbn13}` : b.isbn13)}
              >
                {b.isbn13}
              </button>
            ))}
          </div>
          <label className="text-[11px] text-bf-muted">지점 ID (쉼표 구분)</label>
          <input className="ipt" value={branchInput} onChange={(e) => setBranchInput(e.target.value)} />
          <div className="flex gap-2 flex-wrap">
            {branchOptions.map((l) => (
              <button
                key={l.location_id}
                type="button"
                className="btn-ghost btn-sm"
                title={l.name ?? String(l.location_id)}
                onClick={() => setBranchInput((prev) => prev ? `${prev},${l.location_id}` : String(l.location_id))}
              >
                {l.location_id} {l.name ?? ''}
              </button>
            ))}
          </div>
          <label className="text-[11px] text-bf-muted">캠페인 목표</label>
          <textarea className="ipt min-h-[76px]" value={objective} onChange={(e) => setObjective(e.target.value)} />
          <button className="btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? '생성 중...' : '캠페인 생성'}
          </button>
        </section>

        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">캠페인 목록</h2>
            <span className="label-tag">{campaigns.data?.items.length ?? 0}건</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>제목</th>
                <th>기간</th>
                <th>상태</th>
                <th>도서 수</th>
                <th>지점 수</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.data?.items.map((c) => (
                <tr key={c.campaign_id}>
                  <td className="font-medium">{c.title}</td>
                  <td className="text-[11px]">{c.start_date} ~ {c.end_date}</td>
                  <td><span className="label-tag">{c.status}</span></td>
                  <td>{c.isbn13s.length}</td>
                  <td>{c.target_branch_ids.length}</td>
                  <td className="flex gap-1">
                    <button className="btn-ghost btn-sm" onClick={() => setSelectedId(c.campaign_id)}>열기</button>
                    <button
                      className="btn-ghost btn-sm text-bf-danger"
                      onClick={() => deleteCampaign.mutate(c)}
                      disabled={deleteCampaign.isPending}
                    >삭제</button>
                  </td>
                </tr>
              ))}
              {campaigns.data?.items.length === 0 && (
                <tr><td colSpan={6} className="text-center text-bf-muted py-8">등록된 캠페인이 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {activeCampaign && (
        <section className="card">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="h2">{activeCampaign.title}</h2>
              <p className="text-xs text-bf-muted">
                {activeCampaign.start_date} ~ {activeCampaign.end_date} · {activeCampaign.status}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {recSource && (
                <span className={`label-tag ${recSource === 'gemini' ? 'text-green-600' : 'text-bf-muted'}`}>
                  {recSource === 'gemini' ? '✦ Gemini' : '⚙ mock'}
                </span>
              )}
              <button className="btn-primary" onClick={() => recommend.mutate(activeCampaign)} disabled={recommend.isPending}>
                {recommend.isPending ? '생성 중...' : 'AI 추천 생성'}
              </button>
              <button className="btn-ghost" onClick={() => send.mutate(activeCampaign)} disabled={send.isPending || recommendations.length === 0}>
                {send.isPending ? '발송 중...' : '메일 발송'}
              </button>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>지점</th>
                <th>ISBN</th>
                <th>굿즈</th>
                <th>진열 위치</th>
                <th>우선순위</th>
                <th>추천 사유</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {recommendations.map((r) => (
                <tr key={r.recommendation_id}>
                  <td>{r.branch_id}</td>
                  <td className="font-mono text-[11px]">{r.isbn13}</td>
                  <td>{r.recommended_goods.map((g) => g.name ?? '굿즈').join(', ')}</td>
                  <td>{r.display_position ?? '-'}</td>
                  <td><span className="label-tag">{r.priority}</span></td>
                  <td className="max-w-[360px] text-[11px] text-bf-muted">{r.reason}</td>
                  <td><button className="btn-ghost btn-sm" onClick={() => setEditing(r)}>수정</button></td>
                </tr>
              ))}
              {recommendations.length === 0 && (
                <tr><td colSpan={7} className="text-center text-bf-muted py-8">메일 발송 전 AI 추천을 먼저 생성해주세요.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <EditRecommendationModal
          rec={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={() => saveEdit.mutate(editing)}
          saving={saveEdit.isPending}
        />
      )}
    </div>
  );
}

function EditRecommendationModal({
  rec,
  onChange,
  onClose,
  onSave,
  saving,
}: {
  rec: GoodsRecommendation;
  onChange: (rec: GoodsRecommendation) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const firstGoods = rec.recommended_goods[0]?.name ?? '';
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="card w-[760px] max-w-[94vw] max-h-[88vh] overflow-auto">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="h2">추천 수정</h2>
            <div className="text-xs text-bf-muted">{rec.isbn13} · 지점 {rec.branch_id}</div>
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}>닫기</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-bf-muted">굿즈명</label>
            <input
              className="ipt w-full"
              value={firstGoods}
              onChange={(e) => onChange({ ...rec, recommended_goods: [{ ...(rec.recommended_goods[0] ?? {}), name: e.target.value }] })}
            />
          </div>
          <div>
            <label className="text-[11px] text-bf-muted">진열 위치</label>
            <input
              className="ipt w-full"
              value={rec.display_position ?? ''}
              onChange={(e) => onChange({ ...rec, display_position: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-bf-muted">우선순위</label>
            <select className="ipt w-full" value={rec.priority} onChange={(e) => onChange({ ...rec, priority: e.target.value })}>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-bf-muted">메일 제목</label>
            <input
              className="ipt w-full"
              value={rec.email_subject ?? ''}
              onChange={(e) => onChange({ ...rec, email_subject: e.target.value })}
            />
          </div>
        </div>
        <label className="text-[11px] text-bf-muted mt-3 block">추천 사유</label>
        <textarea className="ipt w-full min-h-[72px]" value={rec.reason ?? ''} onChange={(e) => onChange({ ...rec, reason: e.target.value })} />
        <label className="text-[11px] text-bf-muted mt-3 block">메일 본문</label>
        <textarea className="ipt w-full min-h-[180px] font-mono text-[11px]" value={rec.email_body ?? ''} onChange={(e) => onChange({ ...rec, email_body: e.target.value })} />
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>취소</button>
          <button className="btn-primary" onClick={onSave} disabled={saving}>{saving ? '저장 중...' : '저장'}</button>
        </div>
      </div>
    </div>
  );
}
