// Vercel Serverless: 网页版中转到微信云函数
const { callCloudFunction } = require('../lib/wxcloud');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var { functionName, data } = req.body;
  if (!functionName) return res.status(400).json({ error: 'Missing functionName' });

  try {
    var result = await callCloudFunction(functionName, data);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cloud proxy]', e);
    return res.status(500).json({ error: e.message });
  }
}
