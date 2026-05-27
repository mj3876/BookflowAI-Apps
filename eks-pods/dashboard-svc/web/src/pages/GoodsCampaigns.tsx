import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
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
  const [title, setTitle] = useState('Weekend goods display event');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(plusDays(7));
  const [objective, setObjective] = useState('Increase add-on purchase for selected books during a short event.');
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
    onError: (e) => setError(e instanceof Error ? e.message : 'Create failed'),
  });

  const recommend = useMutation({
    mutationFn: (campaign: GoodsCampaign) => postGoodsCampaignRecommend(role, campaign.campaign_id, 'auto'),
    onSuccess: (_, campaign) => {
      qc.invalidateQueries({ queryKey: ['goods-campaign', campaign.campaign_id] });
      qc.invalidateQueries({ queryKey: ['goods-campaigns'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Recommendation failed'),
  });

  const send = useMutation({
    mutationFn: (campaign: GoodsCampaign) => postGoodsCampaignSend(role, campaign.campaign_id),
    onSuccess: (_, campaign) => {
      qc.invalidateQueries({ queryKey: ['goods-campaign', campaign.campaign_id] });
      qc.invalidateQueries({ queryKey: ['goods-campaigns'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Send failed'),
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
    onError: (e) => setError(e instanceof Error ? e.message : 'Save failed'),
  });

  if (!isHQ) {
    return <div className="card text-sm text-bf-muted">HQ role is required.</div>;
  }

  const activeCampaign = selected.data;
  const recommendations = activeCampaign?.recommendations ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">Goods Event Campaign</h1>
          <p className="text-bf-muted text-xs mt-1">
            On-demand Gemini recommendations for short branch display events. No inventory quantity is changed.
          </p>
        </div>
        {error && <button className="btn-ghost text-bf-danger" onClick={() => setError(null)}>{error}</button>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-4">
        <section className="card flex flex-col gap-3">
          <h2 className="h2">Create Campaign</h2>
          <label className="text-[11px] text-bf-muted">Title</label>
          <input className="ipt" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-bf-muted">Start</label>
              <input className="ipt w-full" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-bf-muted">End</label>
              <input className="ipt w-full" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <label className="text-[11px] text-bf-muted">ISBN13 comma list</label>
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
          <label className="text-[11px] text-bf-muted">Branch IDs comma list</label>
          <input className="ipt" value={branchInput} onChange={(e) => setBranchInput(e.target.value)} />
          <div className="flex gap-2 flex-wrap">
            {branchOptions.slice(0, 8).map((l) => (
              <button
                key={l.location_id}
                type="button"
                className="btn-ghost btn-sm"
                title={l.name ?? String(l.location_id)}
                onClick={() => setBranchInput((prev) => prev ? `${prev},${l.location_id}` : String(l.location_id))}
              >
                {l.location_id}
              </button>
            ))}
          </div>
          <label className="text-[11px] text-bf-muted">Objective</label>
          <textarea className="ipt min-h-[76px]" value={objective} onChange={(e) => setObjective(e.target.value)} />
          <button className="btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create'}
          </button>
        </section>

        <section className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">Campaigns</h2>
            <span className="label-tag">{campaigns.data?.items.length ?? 0} items</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Period</th>
                <th>Status</th>
                <th>Books</th>
                <th>Branches</th>
                <th>Action</th>
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
                  <td>
                    <button className="btn-ghost btn-sm" onClick={() => setSelectedId(c.campaign_id)}>Open</button>
                  </td>
                </tr>
              ))}
              {campaigns.data?.items.length === 0 && (
                <tr><td colSpan={6} className="text-center text-bf-muted py-8">No campaigns yet.</td></tr>
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
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => recommend.mutate(activeCampaign)} disabled={recommend.isPending}>
                {recommend.isPending ? 'Generating...' : 'Generate AI'}
              </button>
              <button className="btn-ghost" onClick={() => send.mutate(activeCampaign)} disabled={send.isPending || recommendations.length === 0}>
                {send.isPending ? 'Sending...' : 'Send Mail'}
              </button>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Branch</th>
                <th>ISBN</th>
                <th>Goods</th>
                <th>Display</th>
                <th>Priority</th>
                <th>Reason</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recommendations.map((r) => (
                <tr key={r.recommendation_id}>
                  <td>{r.branch_id}</td>
                  <td className="font-mono text-[11px]">{r.isbn13}</td>
                  <td>{r.recommended_goods.map((g) => g.name ?? 'Goods').join(', ')}</td>
                  <td>{r.display_position ?? '-'}</td>
                  <td><span className="label-tag">{r.priority}</span></td>
                  <td className="max-w-[360px] text-[11px] text-bf-muted">{r.reason}</td>
                  <td><button className="btn-ghost btn-sm" onClick={() => setEditing(r)}>Edit</button></td>
                </tr>
              ))}
              {recommendations.length === 0 && (
                <tr><td colSpan={7} className="text-center text-bf-muted py-8">Generate recommendations before sending mail.</td></tr>
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
            <h2 className="h2">Edit Recommendation</h2>
            <div className="text-xs text-bf-muted">{rec.isbn13} · branch {rec.branch_id}</div>
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-bf-muted">Goods</label>
            <input
              className="ipt w-full"
              value={firstGoods}
              onChange={(e) => onChange({ ...rec, recommended_goods: [{ ...(rec.recommended_goods[0] ?? {}), name: e.target.value }] })}
            />
          </div>
          <div>
            <label className="text-[11px] text-bf-muted">Display position</label>
            <input
              className="ipt w-full"
              value={rec.display_position ?? ''}
              onChange={(e) => onChange({ ...rec, display_position: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-bf-muted">Priority</label>
            <select className="ipt w-full" value={rec.priority} onChange={(e) => onChange({ ...rec, priority: e.target.value })}>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-bf-muted">Email subject</label>
            <input
              className="ipt w-full"
              value={rec.email_subject ?? ''}
              onChange={(e) => onChange({ ...rec, email_subject: e.target.value })}
            />
          </div>
        </div>
        <label className="text-[11px] text-bf-muted mt-3 block">Reason</label>
        <textarea className="ipt w-full min-h-[72px]" value={rec.reason ?? ''} onChange={(e) => onChange({ ...rec, reason: e.target.value })} />
        <label className="text-[11px] text-bf-muted mt-3 block">Email body</label>
        <textarea className="ipt w-full min-h-[180px] font-mono text-[11px]" value={rec.email_body ?? ''} onChange={(e) => onChange({ ...rec, email_body: e.target.value })} />
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
