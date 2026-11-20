import { createHash } from 'node:crypto';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const { probe } = req.body ?? {};
  if (typeof probe !== 'string' || Buffer.byteLength(probe) > 128) {
    return res.status(400).end();
  }
  const sha256 = createHash('sha256').update(probe).digest('hex');
  return res.status(200).json({ sha256 });
}
