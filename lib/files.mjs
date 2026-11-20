import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const registry = 'https://oci.cnb.cool';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const maxFile = 1024 * 1024;
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function upstream(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw new Failure(502, `Upstream HTTP ${response.status}`);
  return response;
}

function authorized(req, expected) {
  if (!expected) return false;
  const actual = Buffer.from(req.headers.authorization ?? '');
  const correct = Buffer.from('Bearer ' + expected);
  return actual.length === correct.length && timingSafeEqual(actual, correct);
}

function config() {
  return {
    repo: process.env.DRIVE_GITHUB_REPO ?? 'Laoch832/CloudDrive',
    branch: process.env.DRIVE_GITHUB_BRANCH ?? 'codex/cloud-drive-integration',
    artifact: process.env.DRIVE_CNB_ARTIFACT ?? 'canz-monkey/clouddriver/cloud-drive-integration',
    githubToken: process.env.DRIVE_GITHUB_TOKEN,
    cnbToken: process.env.CNB_TOKEN,
  };
}

async function ociToken(artifact, secret, actions) {
  const url = new URL('/service/token', registry);
  url.searchParams.set('service', 'cnb-registry');
  url.searchParams.set('scope', `repository:${artifact}:${actions}`);
  const headers = secret ? { Authorization: 'Basic ' + Buffer.from('cnb:' + secret).toString('base64') } : {};
  const result = await (await upstream(url, { headers })).json();
  if (!result.token && !result.access_token) throw new Failure(502, 'CNB token response invalid');
  return { Authorization: 'Bearer ' + (result.token ?? result.access_token) };
}

async function putBlob(artifact, headers, bytes) {
  const checksum = digest(bytes);
  const path = `${registry}/v2/${artifact}/blobs`;
  const present = await fetch(path + '/' + checksum, { method: 'HEAD', headers, signal: AbortSignal.timeout(18000) });
  if (present.ok) return;
  if (present.status !== 404) throw new Failure(502, 'CNB blob lookup failed');
  const initiated = await upstream(path + '/uploads/', { method: 'POST', headers });
  const location = initiated.headers.get('location');
  if (!location) throw new Failure(502, 'CNB upload location missing');
  const upload = new URL(location, registry);
  if (upload.origin !== registry) throw new Failure(502, 'CNB upload origin invalid');
  upload.searchParams.set('digest', checksum);
  await upstream(upload, {
    method: 'PUT', redirect: 'error',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
}

async function putFile(settings, bytes, checksum) {
  const headers = await ociToken(settings.artifact, settings.cnbToken, 'pull,push');
  const empty = Buffer.from('{}');
  await Promise.all([putBlob(settings.artifact, headers, empty), putBlob(settings.artifact, headers, bytes)]);
  const manifest = {
    schemaVersion: 2, mediaType: manifestType, artifactType: 'application/vnd.unknown.artifact.v1',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: digest(empty), size: empty.length, data: 'e30=' },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: checksum, size: bytes.length,
      annotations: { 'org.opencontainers.image.title': 'file.bin' } }],
  };
  await upstream(`${registry}/v2/${settings.artifact}/manifests/${checksum.replace(':', '-')}`, {
    method: 'PUT', headers: { ...headers, 'Content-Type': manifestType }, body: JSON.stringify(manifest),
  });
}

async function getFile(artifact, token, tag, checksum) {
  const headers = await ociToken(artifact, token, 'pull');
  const base = `${registry}/v2/${artifact}`;
  const manifest = await (await upstream(`${base}/manifests/${tag}`, {
    headers: { ...headers, Accept: manifestType },
  })).json();
  const layer = manifest.layers?.[0];
  if (layer?.digest !== checksum || layer.size > maxFile) throw new Failure(502, 'CNB manifest mismatch');
  const blob = Buffer.from(await (await upstream(`${base}/blobs/${checksum}`, { headers })).arrayBuffer());
  if (blob.length !== layer.size || digest(blob) !== checksum) throw new Failure(502, 'CNB digest mismatch');
  return blob;
}

function githubHeaders(token) {
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: 'Bearer ' + token } : {}) };
}

async function catalog(settings) {
  const url = `https://api.github.com/repos/${settings.repo}/contents/.integration/drive/catalog.json`;
  const headers = githubHeaders(settings.githubToken);
  const response = await fetch(url + '?ref=' + encodeURIComponent(settings.branch), {
    headers, cache: 'no-store', signal: AbortSignal.timeout(18000),
  });
  if (response.status === 404) return { url, headers, rows: [] };
  if (!response.ok) throw new Failure(502, `GitHub catalog HTTP ${response.status}`);
  const current = await response.json();
  return { url, headers, sha: current.sha, rows: JSON.parse(Buffer.from(current.content, 'base64')) };
}

async function saveCatalog(settings, state) {
  const response = await fetch(state.url, {
    method: 'PUT', signal: AbortSignal.timeout(18000),
    headers: { ...state.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: settings.branch, message: 'Update cloud drive integration catalog',
      content: Buffer.from(JSON.stringify(state.rows)).toString('base64'), sha: state.sha,
    }),
  });
  if ([409, 422].includes(response.status)) throw new Failure(409, 'Catalog changed concurrently or branch unavailable');
  if (!response.ok) throw new Failure(502, `GitHub write HTTP ${response.status}`);
}

function validPath(path) {
  if (typeof path !== 'string' || path.length > 512 ||
      /[\\\x00-\x1f]/.test(path) || path.split('/').some(part => ['', '.', '..'].includes(part))) {
    throw new Failure(400, 'Invalid path');
  }
  return path;
}

export async function verifyFixture() {
  const endpoint = 'https://api.github.com/repos/Laoch832/CloudDrive/contents/.integration/drive/fixture.json';
  const { content } = await (await upstream(endpoint + '?ref=codex/cloud-drive-integration',
    { headers: githubHeaders(), cache: 'no-store' })).json();
  const fixture = JSON.parse(Buffer.from(content, 'base64'));
  if (!/^sha256:[a-f0-9]{64}$/.test(fixture.sha) || !/^[a-f0-9]{32}$/.test(fixture.tag)) {
    throw new Failure(502, 'Invalid fixture');
  }
  const bytes = await getFile('canz-monkey/clouddriver/cloud-drive-probe', undefined, fixture.tag, fixture.sha);
  return { sha256: digest(bytes).slice(7), size: bytes.length, metadata: 'github', content: 'cnb' };
}

export async function handleFiles(req, res) {
  try {
    const settings = config();
    if (!authorized(req, process.env.DRIVE_API_TOKEN)) throw new Failure(401, 'Authentication required');
    if (!settings.githubToken || !settings.cnbToken) throw new Failure(503, 'Storage credentials required');
    const search = new URL(req.url, 'http://localhost').searchParams;
    const id = search.get('id');
    const state = await catalog(settings);
    const row = state.rows.find(file => file.id === id);

    if (req.method === 'GET') {
      if (!id) return res.status(200).json(state.rows.filter(file => file.deleted === (search.get('trash') === '1')));
      if (!row || row.deleted) throw new Failure(404, 'File not found');
      const bytes = await getFile(settings.artifact, settings.cnbToken, row.sha.replace(':', '-'), row.sha);
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.status(200).end(bytes);
    }

    if (req.method === 'POST' && !id) {
      const path = validPath(req.body?.path);
      const raw = req.body?.base64;
      if (typeof raw !== 'string' || raw.length > Math.ceil(maxFile / 3) * 4) throw new Failure(413, 'File exceeds 1 MiB or missing');
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.toString('base64') !== raw || bytes.length > maxFile) throw new Failure(400, 'Invalid base64');
      if (state.rows.some(file => !file.deleted && file.path === path)) throw new Failure(409, 'Path already exists');
      const file = { id: randomUUID(), path, sha: digest(bytes), size: bytes.length, deleted: false };
      await putFile(settings, bytes, file.sha);
      state.rows.push(file);
      await saveCatalog(settings, state);
      return res.status(201).json(file);
    }
    if (!row) throw new Failure(404, 'File not found');
    if (req.method === 'PATCH' && !row.deleted) row.path = validPath(req.body?.path);
    else if (req.method === 'DELETE' && !row.deleted) row.deleted = true;
    else if (req.method === 'POST' && search.get('restore') === '1' && row.deleted) row.deleted = false;
    else throw new Failure(405, 'Unsupported operation');
    if (!row.deleted && state.rows.some(file => file.id !== row.id && !file.deleted && file.path === row.path)) {
      throw new Failure(409, 'Path already exists');
    }
    await saveCatalog(settings, state);
    return res.status(200).json(row);
  } catch (error) {
    return res.status(error.status ?? 502).json({ error: error.status ? error.message : 'Storage operation failed' });
  }
}
