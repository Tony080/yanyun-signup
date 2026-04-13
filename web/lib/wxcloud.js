// 共享模块：调用微信云函数
const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const ENV_ID = process.env.WX_ENV_ID || 'cloud1-0gpxf4r95efa2944';

let tokenCache = { token: '', expiresAt: 0 };
let _tokenFetching = null;

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  // 并发去重：多个调用共享同一个 token 请求
  if (!_tokenFetching) {
    _tokenFetching = (async function() {
      var url = 'https://api.weixin.qq.com/cgi-bin/stable_token';
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credential',
          appid: APPID,
          secret: SECRET
        })
      });
      var data = await res.json();
      if (!data.access_token) throw new Error('access_token failed: ' + (data.errmsg || JSON.stringify(data)));
      tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 600) * 1000 };
      return data.access_token;
    })().finally(function() { _tokenFetching = null; });
  }
  return _tokenFetching;
}

async function callCloudFunction(functionName, data) {
  var t0 = Date.now();
  var token = await getAccessToken();
  var tToken = Date.now();
  var url = 'https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=' + token + '&env=' + ENV_ID + '&name=' + functionName;
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {})
  });
  var wxData = await res.json();
  console.log('[perf server]', functionName, 'token:', tToken - t0, 'ms, call:', Date.now() - tToken, 'ms');

  // token 过期自动重试一次
  if (wxData.errcode === 40001 || wxData.errcode === 42001) {
    tokenCache = { token: '', expiresAt: 0 }; // 清缓存
    token = await getAccessToken();
    url = 'https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=' + token + '&env=' + ENV_ID + '&name=' + functionName;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
    wxData = await res.json();
  }

  if (wxData.errcode && wxData.errcode !== 0) {
    throw new Error(wxData.errmsg || 'cloud function error ' + wxData.errcode);
  }
  return JSON.parse(wxData.resp_data);
}

module.exports = { callCloudFunction };
