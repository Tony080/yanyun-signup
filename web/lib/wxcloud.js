// 共享模块：调用微信云函数
const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const ENV_ID = process.env.WX_ENV_ID || 'cloud1-0gpxf4r95efa2944';

let tokenCache = { token: '', expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  var url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + APPID + '&secret=' + SECRET;
  var res = await fetch(url);
  var data = await res.json();
  if (!data.access_token) throw new Error('access_token failed: ' + (data.errmsg || ''));
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

async function callCloudFunction(functionName, data) {
  var token = await getAccessToken();
  var url = 'https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=' + token + '&env=' + ENV_ID + '&name=' + functionName;
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {})
  });
  var wxData = await res.json();
  if (wxData.errcode && wxData.errcode !== 0) {
    throw new Error(wxData.errmsg || 'cloud function error ' + wxData.errcode);
  }
  return JSON.parse(wxData.resp_data);
}

module.exports = { callCloudFunction };
