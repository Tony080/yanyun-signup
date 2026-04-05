// Vercel Serverless: Discord Interaction Endpoint (CUJ v2)
const nacl = require('tweetnacl');
const { waitUntil } = require('@vercel/functions');
const { callCloudFunction } = require('../lib/wxcloud');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const PDT_OFFSET = -7;
var HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22];

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
      case '报名':
        return res.json(replyRich({
          content: '**选择报名方式：**',
          components: [{ type: 1, components: [
            { type: 2, style: 3, label: '⚡ 快速加入', custom_id: 'mode:quick' },
            { type: 2, style: 1, label: '🚗 创建车队', custom_id: 'mode:create' }
          ] }],
          flags: 64
        }));
      case '退出':
        return deferAndProcess(res, appId, token, function() { return handleLeave(userId); });
      case '挪动':
        return deferAndProcess(res, appId, token, function() { return startMove(userId, displayName); });
      case '看板':
        return deferAndProcess(res, appId, token, function() { return handleBoard(); });
      case '改名':
        return deferAndProcess(res, appId, token, function() { return handleRename(userId, opts); });
      case '代报':
        return deferAndProcess(res, appId, token, function() {
          return handleProxy(userId, displayName, opts);
        });
      default:
        return res.json(reply('未知命令'));
    }
  }

  // Component interaction (type 3)
  if (interaction.type === 3) {
    var cid = interaction.data.custom_id;
    var values = interaction.data.values || [];

    // Step 1: mode selection → show time picker
    if (cid === 'mode:quick' || cid === 'mode:create') {
      var mode = cid.split(':')[1];
      return deferComponentAndProcess(res, appId, token, function() {
        return showTimePicker(userId, displayName, mode);
      });
    }

    // Step 2: time selected → show role picker
    if (cid.startsWith('time:')) {
      var parts = cid.split(':');
      var mode = parts[1];
      var hour = values[0]; // from select menu
      return res.json(update({
        content: '**选择职业：**',
        components: [{ type: 1, components: [
          { type: 2, style: 1, label: '🔵 输出', custom_id: 'role:' + mode + ':' + hour + ':输出' },
          { type: 2, style: 3, label: '🟢 霖霖', custom_id: 'role:' + mode + ':' + hour + ':霖霖' }
        ] }]
      }));
    }

    // Step 3: role selected → show recurring picker
    if (cid.startsWith('role:')) {
      var parts = cid.split(':');
      var emoji = parts[3] === '霖霖' ? '🟢' : '🔵';
      return res.json(update({
        content: '**职业：' + emoji + parts[3] + '**\n每周自动报名此时段？',
        components: [{ type: 1, components: [
          { type: 2, style: 1, label: '每周自动', custom_id: 'done:' + parts[1] + ':' + parts[2] + ':' + parts[3] + ':yes' },
          { type: 2, style: 2, label: '仅本周', custom_id: 'done:' + parts[1] + ':' + parts[2] + ':' + parts[3] + ':no' }
        ] }]
      }));
    }

    // Step 4: finalize
    if (cid.startsWith('done:')) {
      var parts = cid.split(':');
      var mode = parts[1], hour = parts[2], role = parts[3], rec = parts[4] === 'yes';
      return deferComponentAndProcess(res, appId, token, function() {
        return finishSignup(userId, displayName, mode, hour, role, rec);
      });
    }

    // Move: time selected
    if (cid === 'move_time') {
      return deferComponentAndProcess(res, appId, token, function() {
        return finishMove(userId, displayName, values[0]);
      });
    }

    return res.json(update({ content: '未知操作' }));
  }

  return res.status(400).end();
};

// ===== Deferred response =====

function deferAndProcess(res, appId, token, fn) {
  res.json({ type: 5, data: { flags: 64 } });
  waitUntil(processAndEdit(appId, token, fn));
}

function deferComponentAndProcess(res, appId, token, fn) {
  res.json({ type: 6 });
  waitUntil(processAndEdit(appId, token, fn));
}

async function processAndEdit(appId, token, fn) {
  try {
    var result = await fn();
    await editOriginal(appId, token, result.data || result);
  } catch (e) {
    console.error('[discord async]', e);
    await editOriginal(appId, token, { content: '出错了: ' + e.message });
  }
}

async function editOriginal(appId, token, data) {
  var url = 'https://discord.com/api/v10/webhooks/' + appId + '/' + token + '/messages/@original';
  var r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) console.error('[editOriginal]', r.status, await r.text());
}

// ===== Response helpers =====

function reply(c, eph) { var d = { content: c }; if (eph) d.flags = 64; return { type: 4, data: d }; }
function replyRich(d) { return { type: 4, data: d }; }
function update(d) { return { type: 7, data: d }; }
function parseOptions(opts) { var m = {}; opts.forEach(function(o) { m[o.name] = o.value; }); return m; }

// ===== Time utils =====

function pad(n) { return String(n).padStart(2, '0'); }

function pdtToUnix(ds, h) {
  var p = ds.split('-');
  return Math.floor(new Date(Date.UTC(+p[0], +p[1]-1, +p[2], h - PDT_OFFSET, 0, 0)).getTime() / 1000);
}

function discordTime(ds, h) { return '<t:' + pdtToUnix(ds, h) + ':t>'; }

function getCurrentSunday() {
  var now = new Date();
  var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  var pdtNow = new Date(utcMs + PDT_OFFSET * 3600000);
  var day = pdtNow.getDay();
  var result = new Date(pdtNow);
  if (day === 0) { if (pdtNow.getHours() >= 23) result.setDate(result.getDate() + 7); }
  else { result.setDate(result.getDate() + (7 - day)); }
  return result.getFullYear() + '-' + pad(result.getMonth() + 1) + '-' + pad(result.getDate());
}

// ===== Cloud functions =====

async function callApi(action, data) { data = data || {}; data.action = action; return await callCloudFunction('api', data); }
async function callLogin(uid, name) { return await callCloudFunction('login', { userId: uid, nickname: name }); }

async function getSlotCounts(wd) {
  var res = await callApi('getSlots', { weekDate: wd });
  var slots = (res.success && res.slots) ? res.slots : [];
  var counts = {};
  HOURS.forEach(function(h) { counts[h] = 0; });
  slots.forEach(function(s) { counts[s.hour] = (counts[s.hour] || 0) + s.count; });
  return counts;
}

// ===== Step 2: time picker =====

async function showTimePicker(userId, displayName, mode) {
  var weekDate = getCurrentSunday();
  await callLogin(userId, displayName);
  var counts = await getSlotCounts(weekDate);

  var lines = HOURS.map(function(h) {
    var c = counts[h] || 0;
    return discordTime(weekDate, h) + ' — ' + (c > 0 ? c + '人' : '虚位以待');
  });

  var options = [];
  if (mode === 'quick') {
    options.push({ label: '🎲 随缘', value: 'any', description: '加入最快满的车' });
  }
  HOURS.forEach(function(h, i) {
    var c = counts[h] || 0;
    var fire = c >= 7 ? ' 🔥' : '';
    options.push({ label: '第' + (i+1) + '场 (' + c + '人)' + fire, value: String(h), description: h + ':00 PT' });
  });

  return update({
    content: '**选择时段' + (mode === 'create' ? '创建车队' : '报名') + '：**\n' + lines.join('\n'),
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'time:' + mode, placeholder: '选择时段...', options: options
    }] }]
  });
}

// ===== Finalize signup =====

async function finishSignup(userId, displayName, mode, hourStr, role, recurring) {
  var weekDate = getCurrentSunday();
  var hour = hourStr === 'any' ? null : parseInt(hourStr);
  var action = mode === 'quick' ? 'quickJoin' : 'createTeam';

  var res = await callApi(action, {
    userId: userId, weekDate: weekDate, hour: hour,
    nickname: displayName, role: role, recurring: recurring
  });

  if (!res.success) return update({ content: '❌ ' + res.message, components: [] });

  var emoji = role === '霖霖' ? '🟢' : '🔵';
  var timeLabel = hour !== null ? discordTime(weekDate, hour) : '随缘';
  var modeLabel = mode === 'create' ? '创建了车队' : '加入了';
  var msg = '✅ **' + displayName + '** ' + modeLabel + ' ' + timeLabel
    + ' 第' + (res.carIndex + 1) + '车 ' + emoji + role
    + (recurring ? '（每周自动）' : '');

  var board = await buildBoardEmbed(weekDate);
  return update({ content: msg, embeds: [board], components: [] });
}

// ===== 代报 command =====

async function handleProxy(userId, displayName, opts) {
  var weekDate = getCurrentSunday();
  var name = (opts['名字'] || '').trim().slice(0, 12);
  var role = opts['职业'] || '输出';
  var hourStr = opts['时段'];

  if (!name) return reply('❌ 请输入名字', true);

  await callLogin(userId, displayName);

  // Check if user is registered
  var slotsRes = await callApi('getSlots', { weekDate: weekDate });
  var mySlot = null;
  if (slotsRes.success) {
    slotsRes.slots.forEach(function(s) {
      if (s.members.some(function(m) { return m.openid === userId; })) {
        mySlot = s;
      }
    });
  }

  var hour = hourStr ? parseInt(hourStr) : (mySlot ? mySlot.hour : null);

  // Use quickJoin with extraMembers (register user first if not registered)
  if (!mySlot) {
    var res = await callApi('quickJoin', {
      userId: userId, weekDate: weekDate, hour: hour,
      nickname: displayName, role: '输出', recurring: false,
      extraMembers: [{ nickname: name, role: role }]
    });
    if (!res.success) return replyRich({ content: '❌ ' + res.message });
  } else {
    // Already registered, just add the proxy member to the same car
    var res = await callApi('quickJoin', {
      userId: userId + '_p' + Date.now(),
      weekDate: weekDate, hour: hour,
      nickname: name, role: role, recurring: false
    });
    // Hacky: we register the proxy as a separate "user" with the same hour
    // Better: add a dedicated addProxy API action later
  }

  var board = await buildBoardEmbed(weekDate);
  return replyRich({ content: '✅ 已代报 **' + name + '** ' + (role === '霖霖' ? '🟢' : '🔵') + role, embeds: [board] });
}

// ===== Move =====

async function startMove(userId, displayName) {
  var weekDate = getCurrentSunday();
  await callLogin(userId, displayName);
  var counts = await getSlotCounts(weekDate);

  var lines = HOURS.map(function(h) { return discordTime(weekDate, h) + ' — ' + (counts[h] || 0) + '人'; });
  var options = HOURS.map(function(h, i) {
    return { label: '第' + (i+1) + '场 (' + (counts[h]||0) + '人)', value: String(h), description: h + ':00 PT' };
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
  var res = await callApi('move', { userId: userId, weekDate: weekDate, targetHour: parseInt(hourStr), nickname: displayName });
  if (!res.success) return update({ content: '❌ ' + res.message, components: [] });
  var board = await buildBoardEmbed(weekDate);
  return update({ content: '🔄 **' + displayName + '** 挪到了 ' + discordTime(weekDate, parseInt(hourStr)), embeds: [board], components: [] });
}

// ===== Leave / Board / Rename =====

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
  var nick = (opts['名字'] || '').trim().slice(0, 12);
  if (!nick) return reply('❌ 请输入名字', true);
  await callApi('updateNickname', { userId: userId, nickname: nick });
  return reply('✅ 已改名为 **' + nick + '**', true);
}

// ===== Board Embed with leader =====

async function buildBoardEmbed(weekDate) {
  var res = await callApi('getSlots', { weekDate: weekDate });
  var slots = (res.success && res.slots) ? res.slots : [];

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
      // Leader name in car title
      var leaderName = '';
      if (car.leader) {
        var leaderMember = car.members.find(function(m) { return m.openid === car.leader; });
        if (leaderMember) leaderName = ' 👑' + leaderMember.nickname;
      }
      lines.push('**第' + (car.carIndex + 1) + '车** (' + car.count + '/10)' + leaderName);

      // Members: leader first, then others
      var sorted = car.members.slice().sort(function(a, b) {
        if (a.openid === car.leader) return -1;
        if (b.openid === car.leader) return 1;
        return 0;
      });
      var memberStrs = sorted.map(function(m) {
        var emoji = m.role === '霖霖' ? '🟢' : '🔵';
        var prefix = m.openid === car.leader ? '👑' : emoji;
        var suffix = m.registeredBy ? '*' : '';
        return prefix + m.nickname + suffix;
      });
      lines.push(memberStrs.join('  '));
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
    title: '🏯 燕云十六声 · 百业十人本',
    description: '📅 ' + firstDate + '  |  共 ' + totalPeople + ' 人',
    color: 0xf0b429, fields: fields,
    footer: { text: '/报名 加入 · /退出 离开 · /挪动 换时段 · /代报 帮别人 · /看板 刷新' }
  };
}
