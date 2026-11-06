// Thin wrappers around the server's JSON API.

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url}: HTTP ${res.status}`);
  return data;
}

/** URL of a project file (robots/..., sensors/...). Each segment is encoded. */
export function fileUrl(path) {
  return '/files/' + path.split('/').map(encodeURIComponent).join('/');
}

export const api = {
  robots: () => getJSON('/api/robots'),
  sensors: () => getJSON('/api/sensors'),
  layouts: () => getJSON('/api/layouts'),
  loadLayout: (name) => getJSON(`/api/layouts/${encodeURIComponent(name)}`),
  saveLayout: (name, layout) => postJSON(`/api/layouts/${encodeURIComponent(name)}`, layout),
  saveSpec: (datasheet, spec) => postJSON('/api/sensors/spec', { datasheet, spec }),
  writeExport: (name, files) => postJSON(`/api/exports/${encodeURIComponent(name)}`, { files }),
  async text(path) {
    const res = await fetch(fileUrl(path), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.text();
  },
};
