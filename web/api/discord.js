// Vercel Serverless: Discord Interaction Endpoint
const nacl = require('tweetnacl');
const { callCloudFunction } = require('../lib/wxcloud');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const PDT_OFFSET = -7;
var WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];

// ===== 入口 =====

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 验证签名
  var sig = req.headers['x-signature-ed25519'];
  var ts = req.headers['x-signature-timestamp'];
  var body = JSON.stringify(req.body);

  var isValid = nacl.sign.detached.verify(
    Buffer.from(ts + body),
    Buffer.from(sig, 'hex'),
    Buffer.from(PUBLIC_KEY, 'hex')
  );
  if (!isValid) return res.status(401).end('Bad signature');

  var interaction = req.body;

  // PING
  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  // Slash command
  if (interaction.type === 2) {
    var name = interaction.data.name;
    var opts = parseOptions(interaction.data.options || []);
    var user = interaction.member ? interaction.member.user : interaction.user;
    var userId = 'dc_' + user.id;
    var displayName = interaction.member ? (interaction.member.nick || user.global_name || user.username) : (user.global_name || user.username);
    var interactionToken = interaction.token;

    // 立即回复 DEFERRED（"thinking..."），然后异步处理
    // 用 waitUntil 让 Vercel 在响应后继续执行异步任务
    var appId = interaction.application_id;

    var asyncWork = (async function() {
      try {
        var result;
        switch (name) {
          case '报名': result = await handleJoin(userId, displayName, opts); break;
          case '退出': result = await handleLeave(userId); break;
          case '挪动': result = await handleMove(userId, displayName, opts); break;
          case '看板': result = await handleBoard(); break;
          case '改名': result = await handleRename(userId, opts); break;
          default: result = { content: '未知命令' };
        }
        await editOriginal(appId, interactionToken, result);
      } catch (e) {
        console.error('[discord]', name, e);
        await editOriginal(appId, interactionToken, { content: '出错了: ' + e.message });
      }
    })();

    // waitUntil 告诉 Vercel：响应已发送，但请等这个 Promise 完成后再终止函数
    if (req.context && req.context.waitUntil) {
      req.context.waitUntil(asyncWork);
    } else if (globalThis[Symbol.for('vercel-request-context')]) {
      globalThis[Symbol.for('vercel-request-context')].get().waitUntil(asyncWork);
    } else {
      // fallback: 等完再返回
      await asyncWork;
    }

    return res.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  return res.status(400).end();
}

// 通过 webhook 编辑延迟回复
async function editOriginal(appId, token, data) {
  var url = 'https://discord.com/api/v10/webhooks/' + appId + '/' + token + '/messages/@original';
  var r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) console.error('[editOriginal] failed:', r.status, await r.text());
}

function parseOptions(opts) {
  var map = {};
  opts.forEach(function(o) { map[o.name] = o.value; });
  return map;
}

// ===== 时区 =====

function pad(n) { return String(n).padStart(2, '0'); }

function getCurrentSunday() {
  var now = new Date();
  var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  var pdtNow = new Date(utcMs + PDT_OFFSET * 3600000);
  var day = pdtNow.getDay();
  var result = new Date(pdtNow);
  if (day === 0) {
    if (pdtNow.getHours() >= 23) result.setDate(result.getDate() + 7);
  } else {
    result.setDate(result.getDate() + (7 - day));
  }
  return result.getFullYear() + '-' + pad(result.getMonth() + 1) + '-' + pad(result.getDate());
}

// 返回 Unix 时间戳（秒）
function pdtToUnix(pdtDateStr, pdtHour) {
  var p = pdtDateStr.split('-');
  return Math.floor(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], pdtHour - PDT_OFFSET, 0, 0)).getTime() / 1000);
}

// Discord 时间戳格式，每个用户自动看到自己的本地时间
function discordTime(pdtDateStr, pdtHour) {
  var ts = pdtToUnix(pdtDateStr, pdtHour);
  return '<t:' + ts + ':t>';  // :t = 短时间格式 如 "5:00 AM"
}

function discordTimeFull(pdtDateStr, pdtHour) {
  var ts = pdtToUnix(pdtDateStr, pdtHour);
  return '<t:' + ts + ':f>';  // :f = 完整格式 如 "April 6, 2026 5:00 AM"
}

// ===== 调云函数 =====

async function callApi(action, data) {
  data = data || {};
  data.action = action;
  return await callCloudFunction('api', data);
}

async function callLogin(userId, nickname) {
  return await callCloudFunction('login', { userId: userId, nickname: nickname });
}

// ===== 命令处理 =====

async function handleJoin(userId, displayName, opts) {
  var weekDate = getCurrentSunday();
  var hour = parseInt(opts['时段']);
  var role = opts['职业'] || '输出';

  await callLogin(userId, displayName);

  var res = await callApi('join', {
    userId: userId, weekDate: weekDate, hour: hour,
    nickname: displayName, role: role, recurring: false
  });

  if (!res.success) return { content: '❌ ' + res.message };

  var emoji = role === '霖霖' ? '🟢' : '🔵';
  var content = '✅ **' + displayName + '** 报名了 ' + discordTime(weekDate, hour) + ' 第' + (res.carIndex + 1) + '车 ' + emoji + role;

  var board = await buildBoardEmbed(weekDate);
  return { content: content, embeds: [board] };
}

async function handleLeave(userId) {
  var weekDate = getCurrentSunday();
  var res = await callApi('leave', { userId: userId, weekDate: weekDate });
  if (!res.success) return { content: '❌ ' + res.message };

  var board = await buildBoardEmbed(weekDate);
  return { content: '👋 已退出本周报名', embeds: [board] };
}

async function handleMove(userId, displayName, opts) {
  var weekDate = getCurrentSunday();
  var targetHour = parseInt(opts['时段']);

  await callLogin(userId, displayName);

  var res = await callApi('move', {
    userId: userId, weekDate: weekDate, targetHour: targetHour, nickname: displayName
  });

  if (!res.success) return { content: '❌ ' + res.message };

  var board = await buildBoardEmbed(weekDate);
  return { content: '🔄 **' + displayName + '** 挪到了 ' + discordTime(weekDate, targetHour), embeds: [board] };
}

async function handleBoard() {
  var weekDate = getCurrentSunday();
  var board = await buildBoardEmbed(weekDate);
  return { embeds: [board] };
}

async function handleRename(userId, opts) {
  var nickname = (opts['名字'] || '').trim().slice(0, 12);
  if (!nickname) return { content: '❌ 请输入名字' };

  await callApi('updateNickname', { userId: userId, nickname: nickname });
  return { content: '✅ 已改名为 **' + nickname + '**' };
}

// ===== 看板 Embed =====

async function buildBoardEmbed(weekDate) {
  var res = await callApi('getSlots', { weekDate: weekDate });
  var slots = (res.success && res.slots) ? res.slots : [];

  var pp = weekDate.split('-');
  var title = '🏯 燕云十六声 · 百业十人本';
  var description = '📅 美西 ' + (+pp[1]) + '月' + (+pp[2]) + '日 周日';

  var byHour = {};
  var totalPeople = 0;
  slots.forEach(function(s) {
    if (!byHour[s.hour]) byHour[s.hour] = [];
    byHour[s.hour].push(s);
    totalPeople += s.count;
  });

  var hours = [14, 15, 16, 17, 18, 19, 20, 21, 22];
  var fields = [];

  hours.forEach(function(hour) {
    var cars = byHour[hour];
    if (!cars || cars.length === 0) return;

    cars.sort(function(a, b) { return a.carIndex - b.carIndex; });
    var lines = [];

    cars.forEach(function(car) {
      lines.push('**第' + (car.carIndex + 1) + '车** (' + car.count + '/10)');
      var members = car.members.map(function(m) {
        var emoji = m.role === '霖霖' ? '🟢' : '🔵';
        return emoji + m.nickname;
      });
      lines.push(members.join('  '));
    });

    fields.push({
      name: '🕐 ' + discordTime(weekDate, hour) + '  (PDT ' + hour + ':00)',
      value: lines.join('\n'),
      inline: false
    });
  });

  if (fields.length === 0) {
    fields.push({ name: '暂无报名', value: '使用 /报名 加入', inline: false });
  }

  return {
    title: title,
    description: description + '  |  共 ' + totalPeople + ' 人',
    color: 0xf0b429,
    fields: fields,
    footer: { text: '/报名 加入 · /退出 离开 · /挪动 换时段 · /看板 刷新' }
  };
}
