// Vercel Serverless: 网页版中转到微信云函数
const { callCloudFunction } = require('../lib/wxcloud');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var { functionName, data, batch } = req.body;

  // 批量调用：{ batch: [{ functionName, data }, ...] }
  if (batch && Array.isArray(batch)) {
    try {
      var results = await Promise.all(batch.map(function(b) {
        return callCloudFunction(b.functionName, b.data).catch(function(e) { return { error: e.message }; });
      }));
      return res.status(200).json(results);
    } catch (e) {
      console.error('[cloud proxy batch]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (!functionName) return res.status(400).json({ error: 'Missing functionName' });

  try {
    var result = await callCloudFunction(functionName, data);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cloud proxy]', e);
    return res.status(500).json({ error: e.message });
  }
}
