import { verifyFixture } from '../lib/files.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.status(200).json(await verifyFixture());
  } catch (error) {
    return res.status(502).json({ error: error.status ? error.message : 'Platform verification failed' });
  }
}
