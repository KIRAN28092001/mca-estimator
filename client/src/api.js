// The estimator's name goes with every request so the change log can say who changed what.
export const USER_KEY = 'mca.user';
export function currentUser() {
  try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; }
}

async function req(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const user = currentUser();
  if (user) headers['X-User'] = user;
  let r;
  try {
    r = await fetch(`/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the server — check your connection.');
  }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText}`);
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b ?? {}),
  put: (u, b) => req('PUT', u, b),
  del: (u) => req('DELETE', u),
};
