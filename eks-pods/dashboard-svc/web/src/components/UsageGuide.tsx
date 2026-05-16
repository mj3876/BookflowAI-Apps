/**
 * 사용법 안내 — 접을 수 있는 role별 안내 섹션 (이슈5 2026-05-16).
 * 페이지 상단에 배치 · 기본 접힘 · role 에 맞는 항목만 표시.
 */
import { useState } from 'react';

export type GuideEntry = { role: string; label: string; lines: string[] };

export default function UsageGuide({
  title = '사용법 안내',
  role,
  entries,
}: {
  title?: string;
  role: string;
  entries: GuideEntry[];
}) {
  const [open, setOpen] = useState(false);
  const mine = entries.filter((e) => e.role === role);
  const others = entries.filter((e) => e.role !== role);

  return (
    <div className="bf-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm font-medium hover:bg-bf-surface/50"
      >
        <span>💡 {title}</span>
        <span className="text-xs text-bf-muted">{open ? '▲ 접기' : '▼ 펼치기'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-bf-border text-sm">
          {mine.map((e) => (
            <div key={e.role} className="rounded border border-bf-primary/30 bg-bf-primary/5 p-2.5">
              <div className="font-medium text-bf-primary mb-1">{e.label} (내 역할)</div>
              <ul className="list-disc list-inside space-y-0.5 text-bf-text">
                {e.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ))}
          {others.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-bf-muted">다른 역할</div>
              {others.map((e) => (
                <div key={e.role} className="rounded border border-bf-border bg-bf-surface/40 p-2.5">
                  <div className="font-medium text-bf-muted mb-1">{e.label}</div>
                  <ul className="list-disc list-inside space-y-0.5 text-bf-muted">
                    {e.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
