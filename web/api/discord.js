// Vercel Serverless: Discord Interaction Endpoint (多轮交互版)
const nacl = require('tweetnacl');
const { waitUntil } = require('@vercel/functions');
const { callCloudFunction } = require('../lib/wxcloud');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const PDT_OFFSET = -7;
var HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22];

// ===== 入口 =====

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

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
  if (interaction.type === 1) return res.json({ type: 1 });

  var user = interaction.member ? interaction.member.user : interaction.user;
  var userId = 'dc_' + user.id;
  var displayName = interaction.member
    ? (interaction.member.nick || user.global_name || user.username)
    : (user.global_name || user.username);
  var appId = interaction.application_id;
  var token = interaction.token;

  // Slash command (type 2)
  if (interaction.type === 2) {
    var name = interaction.data.name;
    var opts = parseOptions(interaction.data.options || []);

    switch (name) {
      // 需要调云函数的：deferred 模式
      case '报名':
        return deferAndProcess(res, appId, token, function() { return startSignup(userId, displayName); });
      case '退出':
        return deferAndProcess(res, appId, token, function() { return handleLeave(userId); });
      case '挪动':
        return deferAndProcess(res, appId, token, function() { return startMove(userId, displayName); });
      case '看板':
        return deferAndProcess(res, appId, token, function() { return handleBoard(); });
      // 纯本地操作：直接响应
      case '改名':
        return deferAndProcess(res, appId, token, function() { return handleRename(userId, opts); });
      default:
        return res.json(reply('未知命令'));
    }
  }

  // Component interaction (type 3): 按钮/下拉菜单
  if (interaction.type === 3) {
    var customId = interaction.data.custom_id;
    var values = interaction.data.values || [];

    // 不需要调云函数的步骤：直接响应（<3s）
    if (customId.startsWith('signup_role:')) {
      var parts = customId.split(':');
      return res.json(await stepRecurring(parts[1], parts[2]));
    }

    // 需要调云函数的步骤：deferred + waitUntil
    if (customId === 'signup_time') {
      return deferComponentAndProcess(res, appId, token, function() { return stepRole(values[0]); });
    }
    if (customId.startsWith('signup_done:')) {
      var parts = customId.split(':');
      return deferComponentAndProcess(res, appId, token, function() {
        return finishSignup(userId, displayName, parts[1], parts[2], parts[3] === 'yes');
      });
    }
    if (customId === 'move_time') {
      return deferComponentAndProcess(res, appId, token, function() {
        return finishMove(userId, displayName, values[0]);
      });
    }

    return res.json(update({ content: '未知操作' }));
  }

  return res.status(400).end();
};

// ===== Deferred 响应工具 =====

// 对 slash command: type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
function deferAndProcess(res, appId, token, asyncFn) {
  res.json({ type: 5, data: { flags: 64 } }); // ephemeral thinking
  waitUntil(processAndEdit(appId, token, asyncFn, false));
}

// 对 component interaction: type 6 = DEFERRED_UPDATE_MESSAGE
function deferComponentAndProcess(res, appId, token, asyncFn) {
  res.json({ type: 6 });
  waitUntil(processAndEdit(appId, token, asyncFn, true));
}

async function processAndEdit(appId, token, asyncFn, isUpdate) {
  try {
    var result = await asyncFn();
    var data = result.data || result;
    await editOriginal(appId, token, data);
  } catch (e) {
    console.error('[discord async]', e);
    await editOriginal(appId, token, { content: '出错了: ' + e.message });
  }
}

async function editOriginal(appId, token, data) {
  var url = 'https://discord.com/api/v10/webhooks/' + appId + '/' + token + '/messages/@original';
  var r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    var text = await r.text();
    console.error('[editOriginal]', r.status, text);
  }
}

// ===== 响应工具 =====

function reply(content, ephemeral) {
  var data = { content: content };
  if (ephemeral) data.flags = 64;
  return { type: 4, data: data };
}

function replyRich(data) {
  return { type: 4, data: data };
}

function update(data) {
  return { type: 7, data: data };
}

function parseOptions(opts) {
  var map = {};
  opts.forEach(function(o) { map[o.name] = o.value; });
  return map;
}

// ===== 时间工具 =====

function pad(n) { return String(n).padStart(2, '0'); }

function pdtToUnix(pdtDateStr, pdtHour) {
  var p = pdtDateStr.split('-');
  return Math.floor(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], pdtHour - PDT_OFFSET, 0, 0)).getTime() / 1000);
}

function discordTime(pdtDateStr, pdtHour) {
  return '<t:' + pdtToUnix(pdtDateStr, pdtHour) + ':t>';
}

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

// ===== 云函数 =====

async function callApi(action, data) {
  data = data || {};
  data.action = action;
  return await callCloudFunction('api', data);
}

async function callLogin(userId, nickname) {
  return await callCloudFunction('login', { userId: userId, nickname: nickname });
}

async function getSlotCounts(weekDate) {
  var res = await callApi('getSlots', { weekDate: weekDate });
  var slots = (res.success && res.slots) ? res.slots : [];
  var counts = {};
  HOURS.forEach(function(h) { counts[h] = 0; });
  slots.forEach(function(s) { counts[s.hour] = (counts[s.hour] || 0) + s.count; });
  return counts;
}

// ===== 报名流程 Step 1: 选时段 =====

async function startSignup(userId, displayName) {
  var weekDate = getCurrentSunday();
  await callLogin(userId, displayName);
  var counts = await getSlotCounts(weekDate);

  var lines = HOURS.map(function(h) {
    var count = counts[h] || 0;
    return discordTime(weekDate, h) + ' — ' + (count > 0 ? count + '人已报名' : '虚位以待');
  });

  var options = HOURS.map(function(h, i) {
    var count = counts[h] || 0;
    return { label: '第' + (i + 1) + '场 (' + count + '人)', value: String(h), description: h + ':00 PT' };
  });

  return replyRich({
    content: '**选择时段报名：**\n' + lines.join('\n'),
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'signup_time', placeholder: '选择时段...', options: options
    }] }],
    flags: 64
  });
}

// ===== Step 2: 选职业（不调云函数，直接返回） =====

async function stepRole(hourStr) {
  return update({
    content: '**选择职业：**',
    components: [{ type: 1, components: [
      { type: 2, style: 1, label: '🔵 输出', custom_id: 'signup_role:' + hourStr + ':输出' },
      { type: 2, style: 3, label: '🟢 霖霖', custom_id: 'signup_role:' + hourStr + ':霖霖' }
    ] }]
  });
}

// ===== Step 3: 每周自动（不调云函数，直接返回） =====

async function stepRecurring(hourStr, role) {
  var emoji = role === '霖霖' ? '🟢' : '🔵';
  return update({
    content: '**职业：' + emoji + role + '**\n每周自动报名此时段？',
    components: [{ type: 1, components: [
      { type: 2, style: 1, label: '每周自动', custom_id: 'signup_done:' + hourStr + ':' + role + ':yes' },
      { type: 2, style: 2, label: '仅本周', custom_id: 'signup_done:' + hourStr + ':' + role + ':no' }
    ] }]
  });
}

// ===== Step 4: 完成报名 =====

async function finishSignup(userId, displayName, hourStr, role, recurring) {
  var weekDate = getCurrentSunday();
  var hour = parseInt(hourStr);

  var res = await callApi('join', {
    userId: userId, weekDate: weekDate, hour: hour,
    nickname: displayName, role: role, recurring: recurring
  });

  if (!res.success) return update({ content: '❌ ' + res.message, components: [] });

  var emoji = role === '霖霖' ? '🟢' : '🔵';
  var msg = '✅ **' + displayName + '** 报名了 ' + discordTime(weekDate, hour)
    + ' 第' + (res.carIndex + 1) + '车 ' + emoji + role
    + (recurring ? '（每周自动）' : '');

  var board = await buildBoardEmbed(weekDate);
  return update({ content: msg, embeds: [board], components: [] });
}

// ===== 挪动 =====

async function startMove(userId, displayName) {
  var weekDate = getCurrentSunday();
  await callLogin(userId, displayName);
  var counts = await getSlotCounts(weekDate);

  var lines = HOURS.map(function(h) {
    return discordTime(weekDate, h) + ' — ' + (counts[h] || 0) + '人';
  });

  var options = HOURS.map(function(h, i) {
    return { label: '第' + (i + 1) + '场 (' + (counts[h] || 0) + '人)', value: String(h), description: h + ':00 PT' };
  });

  return replyRich({
    content: '**选择要挪到的时段：**\n' + lines.join('\n'),
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'move_time', placeholder: '选择目标时段...', options: options
    }] }],
    flags: 64
  });
}

async function finishMove(userId, displayName, hourStr) {
  var weekDate = getCurrentSunday();
  var targetHour = parseInt(hourStr);

  var res = await callApi('move', {
    userId: userId, weekDate: weekDate, targetHour: targetHour, nickname: displayName
  });

  if (!res.success) return update({ content: '❌ ' + res.message, components: [] });

  var board = await buildBoardEmbed(weekDate);
  return update({
    content: '🔄 **' + displayName + '** 挪到了 ' + discordTime(weekDate, targetHour),
    embeds: [board], components: []
  });
}

// ===== 退出 / 看板 / 改名 =====

async function handleLeave(userId) {
  var weekDate = getCurrentSunday();
  var res = await callApi('leave', { userId: userId, weekDate: weekDate });
  if (!res.success) return reply('❌ ' + res.message);
  var board = await buildBoardEmbed(weekDate);
  return replyRich({ content: '👋 已退出本周报名', embeds: [board] });
}

async function handleBoard() {
  var weekDate = getCurrentSunday();
  var board = await buildBoardEmbed(weekDate);
  return replyRich({ embeds: [board] });
}

async function handleRename(userId, opts) {
  var nickname = (opts['名字'] || '').trim().slice(0, 12);
  if (!nickname) return reply('❌ 请输入名字', true);
  await callApi('updateNickname', { userId: userId, nickname: nickname });
  return reply('✅ 已改名为 **' + nickname + '**', true);
}

// ===== 看板 Embed =====

async function buildBoardEmbed(weekDate) {
  var res = await callApi('getSlots', { weekDate: weekDate });
  var slots = (res.success && res.slots) ? res.slots : [];

  var title = '🏯 燕云十六声 · 百业十人本';
  var firstDate = '<t:' + pdtToUnix(weekDate, 14) + ':D>';

  var byHour = {};
  var totalPeople = 0;
  slots.forEach(function(s) {
    if (!byHour[s.hour]) byHour[s.hour] = [];
    byHour[s.hour].push(s);
    totalPeople += s.count;
  });

  var fields = [];
  HOURS.forEach(function(hour) {
    var cars = byHour[hour];
    if (!cars || cars.length === 0) return;
    cars.sort(function(a, b) { return a.carIndex - b.carIndex; });
    var lines = [];
    cars.forEach(function(car) {
      lines.push('**第' + (car.carIndex + 1) + '车** (' + car.count + '/10)');
      var members = car.members.map(function(m) {
        return (m.role === '霖霖' ? '🟢' : '🔵') + m.nickname;
      });
      lines.push(members.join('  '));
    });
    fields.push({
      name: '🕐 ' + discordTime(weekDate, hour) + ' 本地时间',
      value: lines.join('\n'), inline: false
    });
  });

  if (fields.length === 0) {
    fields.push({ name: '暂无报名', value: '使用 /报名 加入', inline: false });
  }

  return {
    title: title,
    description: '📅 ' + firstDate + '  |  共 ' + totalPeople + ' 人',
    color: 0xf0b429, fields: fields,
    footer: { text: '/报名 加入 · /退出 离开 · /挪动 换时段 · /看板 刷新' }
  };
}
