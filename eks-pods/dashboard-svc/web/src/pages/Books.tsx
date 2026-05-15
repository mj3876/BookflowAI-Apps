import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchBestsellers,
  fetchBooks,
  fetchBookCategories,
  fetchBookAudit,
  updateBookStatus,
  type Book,
  type BookStatusFilter,
  type BookStatusMode,
  type Role,
} from '../api';
import { roleGroup } from '../auth';
import KpiBar from '../components/charts/KpiBar';
import KpiPie from '../components/charts/KpiPie';

const PAGE_SIZE = 50;

const STATUS_TABS: { key: BookStatusFilter; label: string; hint: string }[] = [
  { key: 'ACTIVE',   label: '판매중',   hint: '자동 사이클 정상 작동' },
  { key: 'SOFT_DC',  label: '소진 모드', hint: '신규 발주 차단 · 재분배만 허용' },
  { key: 'INACTIVE', label: '비활성',   hint: '예측·발주·재분배 모두 정지' },
  { key: 'ALL',      label: '전체',     hint: '필터 없음' },
];

function StatusPill({ book }: { book: Book }) {
  if (!book.active) return <span className="pill-rejected">비활성</span>;
  if (book.discontinue_mode === 'SOFT_DISCONTINUE')
    return <span className="pill-pending">소진 모드</span>;
  return <span className="pill-approved">판매중</span>;
}

export default function Books() {
  const { role } = useOutletContext<{ role: Role }>();
  const isHQ = roleGroup(role) === 'HQ';
  const qc = useQueryClient();

  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [statusTab, setStatusTab] = useState<BookStatusFilter>('ACTIVE');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(0);

  const [statusModalBook, setStatusModalBook] = useState<Book | null>(null);
  const [auditBook, setAuditBook] = useState<Book | null>(null);

  const books = useQuery({
    queryKey: ['books', q, statusTab, category, page, role],
    queryFn: () => fetchBooks(role, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      q: q || undefined,
      status: statusTab,
      category: category || undefined,
    }),
    placeholderData: keepPreviousData,
  });

  const categories = useQuery({
    queryKey: ['book-categories', role],
    queryFn: () => fetchBookCategories(role),
    staleTime: 60_000,
  });

  // 신규 BI 차트 (2026-05-13) -------------------------------------------
  // 30일 베스트셀러 top 10 (mini bar) — 5 분
  const bestsellers = useQuery({
    queryKey: ['books-bestsellers-30d', role],
    queryFn: () => fetchBestsellers(role, 30, 10),
    staleTime: 5 * 60 * 1000,
  });

  // 카테고리 분포 pie (보유 도서) — fetchBookCategories 활용
  const catPieChart = useMemo(() => {
    const items = categories.data?.items ?? [];
    const sorted = [...items].sort((a, b) => b.count - a.count);
    const top = sorted.slice(0, 8).map((c) => ({ name: c.category || '미분류', value: c.count }));
    const rest = sorted.slice(8).reduce((s, c) => s + c.count, 0);
    return rest > 0 ? [...top, { name: '기타', value: rest }] : top;
  }, [categories.data?.items]);

  // 출판사별 보유 top 10 (현재 페이지 books 기반 frontend GROUP BY — limit=50 샘플)
  const publisherChart = useMemo(() => {
    const byPub = new Map<string, number>();
    for (const b of books.data?.items ?? []) {
      const pub = b.publisher ?? '미상';
      byPub.set(pub, (byPub.get(pub) ?? 0) + 1);
    }
    return [...byPub.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [books.data?.items]);

  // 베스트셀러 mini bar
  const bestChart = useMemo(
    () =>
      (bestsellers.data?.items ?? []).map((b) => ({
        name: (b.title ?? b.isbn13).slice(0, 18),
        value: b.qty,
      })),
    [bestsellers.data?.items],
  );

  const totalPages = books.data ? Math.ceil(books.data.total / PAGE_SIZE) : 0;

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    setQ(qInput.trim());
  };

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ['books'] });
  };

  const tabCountHint = useMemo(() => {
    if (!books.data) return '';
    return `${books.data.total.toLocaleString()}건`;
  }, [books.data]);

  return (
    <div className="flex flex-col gap-4">
      {/* 헤더 + 검색 */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">도서 카탈로그</h1>
          <p className="text-bf-muted text-xs mt-1">
            알라딘 OpenAPI 시드 1000책 ·{' '}
            {isHQ ? (
              <>본사 마스터 컨트롤 — 도서 ON/OFF + <b>소진 모드</b> 관리 가능</>
            ) : (
              <>읽기 전용 (ON/OFF 변경은 본사만)</>
            )}
          </p>
        </div>
        <form onSubmit={onSearch} className="flex gap-2">
          <input
            className="ipt w-64"
            placeholder="제목 / 저자 / ISBN13 검색…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
          <button type="submit" className="btn-primary">검색</button>
          {q && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { setQ(''); setQInput(''); setPage(0); }}
            >
              초기화
            </button>
          )}
        </form>
      </div>

      {/* 상태 탭 + 카테고리 */}
      <div className="card-tight">
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              title={t.hint}
              onClick={() => { setStatusTab(t.key); setPage(0); }}
              className={`btn ${statusTab === t.key ? 'btn-primary' : 'btn-ghost'}`}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-2 text-bf-muted text-[11px]">·</span>
          <select
            className="ipt"
            value={category}
            onChange={(e) => { setCategory(e.target.value); setPage(0); }}
          >
            <option value="">전체 카테고리</option>
            {categories.data?.items.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.count})
              </option>
            ))}
          </select>
          {category && (
            <button className="btn-ghost btn-sm" onClick={() => { setCategory(''); setPage(0); }}>
              카테고리 해제
            </button>
          )}
          <span className="ml-auto label-tag">{tabCountHint}</span>
        </div>
      </div>

      {/* 테이블 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <span className="label-tag">
            {books.data
              ? `${books.data.total.toLocaleString()}건 중 ${books.data.offset + 1}–${Math.min(books.data.offset + PAGE_SIZE, books.data.total)}`
              : '로딩…'}
          </span>
          <div className="flex gap-2">
            <button
              className="btn-ghost btn-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              이전
            </button>
            <span className="text-xs text-bf-muted self-center">
              {page + 1} / {Math.max(1, totalPages)}
            </span>
            <button
              className="btn-ghost btn-sm"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              다음
            </button>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-[60px]">표지</th>
              <th>ISBN13</th>
              <th>제목</th>
              <th>저자</th>
              <th>출판사</th>
              <th>카테고리</th>
              <th className="text-right">정가</th>
              <th className="text-right">판매가</th>
              <th>상태</th>
              <th>액션</th>
            </tr>
          </thead>
          <tbody>
            {books.isLoading && (
              <tr><td colSpan={10} className="text-center py-6 text-bf-muted">로딩 중…</td></tr>
            )}
            {books.data?.items.map((b) => (
              <tr key={b.isbn13}>
                <td>
                  {b.cover_url ? (
                    <img
                      src={b.cover_url}
                      alt={b.title}
                      className="w-[44px] h-[60px] object-cover rounded-sm border border-bf-border"
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                  ) : (
                    <div className="w-[44px] h-[60px] bg-bf-panel2 rounded-sm border border-bf-border" />
                  )}
                </td>
                <td className="font-mono text-[11px]">{b.isbn13}</td>
                <td className="font-medium">{b.title}</td>
                <td>{b.author ?? '-'}</td>
                <td>{b.publisher ?? '-'}</td>
                <td className="text-bf-muted">{b.category ?? '-'}</td>
                <td className="text-right">{b.price_standard ? `₩${b.price_standard.toLocaleString()}` : '-'}</td>
                <td className="text-right">{b.price_sales ? `₩${b.price_sales.toLocaleString()}` : '-'}</td>
                <td><StatusPill book={b} /></td>
                <td>
                  <div className="flex gap-1">
                    {isHQ && (
                      <button
                        className="btn-ghost btn-sm"
                        title="ON/OFF · 소진 모드 변경 (본사 마스터 컨트롤)"
                        onClick={() => setStatusModalBook(b)}
                      >
                        상태 변경
                      </button>
                    )}
                    <button
                      className="btn-ghost btn-sm"
                      title="변경 이력 (audit_log)"
                      onClick={() => setAuditBook(b)}
                    >
                      이력
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {books.data && books.data.items.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-10 text-bf-muted">
                  <div className="text-sm font-medium text-bf-text mb-1">결과 없음</div>
                  <div className="text-[11px]">
                    {q ? `"${q}" 로 검색된 결과가 없습니다.` : '이 탭에 해당하는 도서가 없습니다.'}
                    {(q || category) && ' 검색·필터를 해제해 보세요.'}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 신규 BI 차트 (2026-05-13) — 카테고리 분포 + 출판사 top 10 + 베스트셀러 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card">
          <h3 className="h3 mb-2">카테고리 분포 (보유 도서)</h3>
          <KpiPie data={catPieChart} height={260} isLoading={categories.isLoading} />
        </div>
        <div className="card">
          <h3 className="h3 mb-2">출판사별 보유 top 10 (현재 페이지)</h3>
          <KpiBar
            data={publisherChart}
            horizontal
            height={260}
            isLoading={books.isLoading}
          />
        </div>
        <div className="card">
          <h3 className="h3 mb-2">🏆 30일 베스트셀러 top 10</h3>
          <KpiBar
            data={bestChart}
            horizontal
            height={260}
            isLoading={bestsellers.isLoading}
          />
        </div>
      </div>

      {statusModalBook && (
        <StatusChangeModal
          book={statusModalBook}
          role={role}
          onClose={() => setStatusModalBook(null)}
          onSuccess={() => {
            setStatusModalBook(null);
            refetchAll();
          }}
        />
      )}
      {auditBook && (
        <AuditModal book={auditBook} role={role} onClose={() => setAuditBook(null)} />
      )}
    </div>
  );
}

// ─── Status change modal ─────────────────────────────────────────────
const MODE_DESCRIPTIONS: Record<BookStatusMode, { label: string; desc: string; pill: string }> = {
  NORMAL:           { label: '판매중 (자동 사이클 ON)', desc: '예측·발주·재분배 모두 정상',           pill: 'pill-approved' },
  SOFT_DISCONTINUE: { label: '소진 모드',                desc: '신규 발주 차단 · 재분배는 허용 (재고 자연 소진)', pill: 'pill-pending'  },
  INACTIVE:         { label: '비활성 (자동 사이클 OFF)',  desc: '예측·발주·재분배 모두 정지 (절판 등)',  pill: 'pill-rejected' },
};

function StatusChangeModal({
  book, role, onClose, onSuccess,
}: { book: Book; role: Role; onClose: () => void; onSuccess: () => void }) {
  const currentMode: BookStatusMode = !book.active
    ? 'INACTIVE'
    : book.discontinue_mode === 'SOFT_DISCONTINUE'
    ? 'SOFT_DISCONTINUE'
    : 'NORMAL';
  const [mode, setMode] = useState<BookStatusMode>(currentMode);
  const [reason, setReason] = useState(book.discontinue_reason ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needReason = mode !== 'NORMAL';
  const disabled = submitting || mode === currentMode || (needReason && !reason.trim());

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await updateBookStatus(role, book.isbn13, { mode, reason: reason.trim() || undefined });
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="card w-[520px] max-w-[90vw]">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="h2">도서 상태 변경</h2>
            <div className="text-xs text-bf-muted mt-0.5">
              {book.title} · <span className="font-mono">{book.isbn13}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-bf-muted hover:text-bf-text" title="닫기">×</button>
        </div>
        <div className="flex flex-col gap-2 mb-4">
          {(Object.keys(MODE_DESCRIPTIONS) as BookStatusMode[]).map((m) => {
            const info = MODE_DESCRIPTIONS[m];
            const isSelected = mode === m;
            const isCurrent = currentMode === m;
            return (
              <label
                key={m}
                className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${
                  isSelected ? 'border-bf-primary bg-bf-panel2' : 'border-bf-border bg-bf-panel'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1"
                  checked={isSelected}
                  onChange={() => setMode(m)}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={info.pill}>{info.label}</span>
                    {isCurrent && <span className="text-[10px] text-bf-muted">(현재)</span>}
                  </div>
                  <div className="text-[11px] text-bf-muted mt-0.5">{info.desc}</div>
                </div>
              </label>
            );
          })}
        </div>
        {needReason && (
          <div className="mb-4">
            <label className="text-[11px] text-bf-muted">사유 (필수 · 감사 로그 기록)</label>
            <input
              className="ipt w-full mt-1"
              placeholder="예) 절판 / 시즌 종료 / 본사 정책 / 판매 부진 …"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={100}
              autoFocus
            />
          </div>
        )}
        {error && <div className="text-xs text-bf-danger mb-2">⚠ {error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>취소</button>
          <button
            className="btn-primary"
            onClick={onSubmit}
            disabled={disabled}
            title={mode === currentMode ? '이미 이 상태입니다' : ''}
          >
            {submitting ? '적용 중…' : '적용'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Audit history modal ──────────────────────────────────────────────
function AuditModal({ book, role, onClose }: { book: Book; role: Role; onClose: () => void }) {
  const audit = useQuery({
    queryKey: ['book-audit', book.isbn13, role],
    queryFn: () => fetchBookAudit(role, book.isbn13),
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="card w-[640px] max-w-[90vw] max-h-[80vh] overflow-auto">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="h2">변경 이력</h2>
            <div className="text-xs text-bf-muted mt-0.5">
              {book.title} · <span className="font-mono">{book.isbn13}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-bf-muted hover:text-bf-text">×</button>
        </div>
        {audit.isLoading && <div className="text-xs text-bf-muted">로딩…</div>}
        {audit.data && audit.data.items.length === 0 && (
          <div className="text-center py-8 text-bf-muted">
            <div className="text-sm font-medium text-bf-text mb-1">변경 이력 없음</div>
            <div className="text-[11px]">아직 본사가 이 도서의 상태를 변경한 적이 없습니다.</div>
          </div>
        )}
        {audit.data && audit.data.items.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>액션</th>
                <th>처리자</th>
                <th>변경 내용</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.items.map((row) => {
                const after = row.after_state || {};
                const mode = (after as { mode?: string }).mode;
                const reason = (after as { reason?: string }).reason;
                return (
                  <tr key={row.log_id}>
                    <td className="text-[11px]">{row.ts ? new Date(row.ts).toLocaleString('ko-KR') : '-'}</td>
                    <td className="text-[11px] font-mono text-bf-muted">{row.action}</td>
                    <td className="text-[11px] font-mono">{row.actor_id ?? '-'}</td>
                    <td className="text-[11px]">
                      {mode && <span className="font-medium">{mode}</span>}
                      {reason && <span className="text-bf-muted"> · {reason}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
