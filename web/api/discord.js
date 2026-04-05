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
      return res.json({ type: 4, data: result });
    } catch (e) {
      console.error('[discord]', name, e);
      return res.json({ type: 4, data: { content: '出错了: ' + e.message, flags: 64 } });
    }
  }

  return res.status(400).end();
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

function pdtToLocal(pdtDateStr, pdtHour) {
  var p = pdtDateStr.split('-');
  var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], pdtHour - PDT_OFFSET, 0, 0));
  return WEEKDAYS[dt.getDay()] + ' ' + pad(dt.getHours()) + ':00';
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

  // 确保用户存在
  await callLogin(userId, displayName);

  var res = await callApi('join', {
    userId: userId, weekDate: weekDate, hour: hour,
    nickname: displayName, role: role, recurring: false
  });

  if (!res.success) return { content: '❌ ' + res.message };

  var localTime = pdtToLocal(weekDate, hour);
  var emoji = role === '霖霖' ? '🟢' : '🔵';
  var content = '✅ **' + displayName + '** 报名了 ' + localTime + ' 第' + (res.carIndex + 1) + '车 ' + emoji + role;

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

  var localTime = pdtToLocal(weekDate, targetHour);
  var board = await buildBoardEmbed(weekDate);
  return { content: '🔄 **' + displayName + '** 挪到了 ' + localTime, embeds: [board] };
}

async function handleBoard() {
  var weekDate = getCurrentSunday();
  var board = await buildBoardEmbed(weekDate);
  return { embeds: [board] };
}

async function handleRename(userId, opts) {
  var nickname = (opts['名字'] || '').trim().slice(0, 12);
  if (!nickname) return { content: '❌ 请输入名字', flags: 64 };

  await callApi('updateNickname', { userId: userId, nickname: nickname });
  return { content: '✅ 已改名为 **' + nickname + '**', flags: 64 };
}

// ===== 看板 Embed =====

async function buildBoardEmbed(weekDate) {
  var res = await callApi('getSlots', { weekDate: weekDate });
  var slots = (res.success && res.slots) ? res.slots : [];

  var pp = weekDate.split('-');
  var title = '🏯 燕云十六声 · 百业十人本';
  var description = '📅 美西 ' + (+pp[1]) + '月' + (+pp[2]) + '日 周日';

  // 按小时分组
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
    var localTime = pdtToLocal(weekDate, hour);
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
      name: '🕐 ' + localTime + '  (PDT ' + hour + ':00)',
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
