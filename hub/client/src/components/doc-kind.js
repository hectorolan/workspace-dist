import { createContext, useContext, useEffect } from 'react';

/**
 * Detail-page kind reporting (hn-documents-subtabs-2026-08-15, assumption 4):
 * `/plans/:slug` is the canonical detail URL for EVERY plan kind, so the path
 * alone cannot tell the Documents subtab bar which subtab owns the page. The
 * detail page reports its loaded kind up through this context; while nothing is
 * reported (loading, non-plan routes) the subtab derives from the path alone.
 * Lives in its own module so pages never import App.jsx (no import cycle).
 */
export const DocKindContext = createContext(() => {});

/** Report `kind` for the lifetime of the calling page; clears on unmount.
 *  Call unconditionally (hooks rule) — null/undefined simply reports nothing. */
export function useReportDocKind(kind) {
  const setKind = useContext(DocKindContext);
  useEffect(() => {
    setKind(kind || null);
    return () => setKind(null);
  }, [kind, setKind]);
}

/** Which Documents subtab owns a plan kind (the display partition — mirrors
 *  isRecordKind in src/lib/plans.js: records are the catch-all). */
export function subtabForKind(kind) {
  if (!kind) return null;
  if (kind === 'plan') return 'plans';
  if (kind === 'test-plan') return 'tests';
  return 'records';
}
