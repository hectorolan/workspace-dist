import { useCallback, useEffect, useState } from 'react';

/**
 * Fetch layer for the hub API. Every response is JSON `{ok, ...}` with the
 * real status code on the wire (test-plan assumption 3). A 401 means the session
 * expired: reload the document so the server's auth wall performs the Google
 * redirect (requireAuth never redirects an /api fetch).
 */

/** GET an API path. Resolves {status, data}; rejects only on network failure. */
export async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    window.location.reload();
    return new Promise(() => {}); // the reload owns the page from here
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** POST JSON to an API path. Same 401 + envelope semantics as apiGet. */
export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.reload();
    return new Promise(() => {});
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/**
 * Page-data hook: `{loading, status, data, error, refetch}`. `error` is the
 * server's message for any non-2xx status (404 not found, 503 not configured,
 * 502 unreachable) or a network-failure message; pages render it verbatim.
 */
export function useApi(path) {
  const [state, setState] = useState({ loading: true, status: 0, data: null, error: null });

  const load = useCallback(() => {
    let live = true;
    setState({ loading: true, status: 0, data: null, error: null });
    apiGet(path)
      .then(({ status, data }) => {
        if (!live) return;
        if (status >= 200 && status < 300 && data.ok !== false) {
          setState({ loading: false, status, data, error: null });
        } else {
          setState({ loading: false, status, data: null, error: data.error || `The server responded ${status}.` });
        }
      })
      .catch(() => {
        if (live) setState({ loading: false, status: 0, data: null, error: 'hub could not be reached. Try again in a moment.' });
      });
    return () => {
      live = false;
    };
  }, [path]);

  useEffect(() => load(), [load]);

  return { ...state, refetch: load };
}
