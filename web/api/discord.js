// Vercel Serverless: Discord Interaction Endpoint (CUJ v2 - Multi-Activity)
const nacl = require('tweetnacl');
const { waitUntil } = require('@vercel/functions');
const { callCloudFunction } = require('../lib/wxcloud');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const PDT_OFFSET = -7;
var WEEKDAY_NAMES = ['周日','周一','周二','周三','周四','周五','周六'];

// ===== Activity config =====

async function getActivities() {
  var res = await callApi('getActivities', {});
  return (res.success && res.activities) ? res.activities : [];
}

function getActivityConfig(activities, id) {
  return activities.find(function(a) { return a.id === id; }) || activities[0] || { id: 'default', name: 'Default', maxPerCar: 10, startHour: 12, endHour: 22, roles: [{name:'输出',color:'#58a6ff'}] };
}

function getHoursForActivity(config) {
  var hours = [];
  for (var h = config.startHour; h <= config.endHour; h++) hours.push(h);
  return hours;
}

// ===== Time / date utils =====

function getPDTNow() {
  var now = new Date();
  var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + PDT_OFFSET * 3600000);
}

function getWeekDateForDay(dayDateStr) {
  var pdtNow = getPDTNow();
  var todayStr = fmtDate(pdtNow);
  var p = dayDateStr.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  var dow = d.getDay();
  if (dow === 0) {
    if (dayDateStr === todayStr && pdtNow.getHours() < 14) {
      d.setDate(d.getDate() - 7);
      return fmtDate(d);
    }
    return dayDateStr;
  }
  d.setDate(d.getDate() - dow);
  return fmtDate(d);
}

function fmtDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}

function getRollingDays() {
  var pdtNow = getPDTNow();
  var today = new Date(pdtNow.getFullYear(), pdtNow.getMonth(), pdtNow.getDate());
  var days = [];
  for (var i = -1; i <= 7; i++) {
    var d = new Date(today);
    d.setDate(today.getDate() + i);
    var dayDate = fmtDate(d);
    var dow = d.getDay();
    days.push({
      windowIndex: i + 1,
      dayDate: dayDate,
      weekDate: getWeekDateForDay(dayDate),
      dayOfWeek: dow,
      dayName: WEEKDAY_NAMES[dow],
      shortDate: (d.getMonth()+1) + '/' + d.getDate()
    });
  }
  return days;
}

function getWindowWeekDates() {
  var days = getRollingDays();
  var seen = {};
  var result = [];
  for (var i = 0; i < days.length; i++) {
    if (!seen[days[i].weekDate]) {
      seen[days[i].weekDate] = true;
      result.push(days[i].weekDate);
    }
  }
  return result;
}

function getDaysOfWeek(weekDate) {
  var p = weekDate.split('-');
  var sun = new Date(+p[0], +p[1]-1, +p[2]);
  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(sun);
    d.setDate(sun.getDate() + i);
    days.push({ dayIndex: i, dayDate: fmtDate(d), dayName: WEEKDAY_NAMES[i], shortDate: (d.getMonth()+1) + '/' + d.getDate() });
  }
  return days;
}

// ===== Handler =====

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
        return deferAndProcess(res, appId, token, function() { return startSignup(); });
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

    // Step 0: activity selected → show mode selection
    if (cid === 'activity_select') {
      var activityId = values[0];
      return res.json(update({
        content: '**选择报名方式：**',
        components: [{ type: 1, components: [
          { type: 2, style: 3, label: '⚡ 快速加入', custom_id: 'mode:' + activityId + ':quick' },
          { type: 2, style: 1, label: '🚗 创建车队', custom_id: 'mode:' + activityId + ':create' }
        ] }]
      }));
    }

    // Step 1: mode selection → show day picker
    if (cid.startsWith('mode:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var mode = parts[2];
      return deferComponentAndProcess(res, appId, token, function() {
        return showDayPicker(userId, displayName, activityId, mode);
      });
    }

    // Step 2: day selected → show time picker
    if (cid.startsWith('day:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var mode = parts[2];
      var dayIndex = parseInt(parts[3]);
      return deferComponentAndProcess(res, appId, token, function() {
        return showTimePicker(userId, displayName, activityId, mode, dayIndex);
      });
    }

    // Switch role button on time picker
    if (cid.startsWith('switchrole:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var mode = parts[2];
      var newRole = parts[3];
      var dayIndex = parseInt(parts[4]);
      return deferComponentAndProcess(res, appId, token, function() {
        return showTimePickerWithRole(userId, displayName, activityId, mode, newRole, dayIndex);
      });
    }

    // Step 3: time selected → show recurring picker (role already known)
    if (cid.startsWith('time:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var mode = parts[2];
      var role = parts[3];
      var dayIndex = parts[4];
      var hour = values[0]; // from select menu
      return deferComponentAndProcess(res, appId, token, function() {
        return showRecurringPicker(activityId, mode, hour, role, dayIndex);
      });
    }

    // Step 4: finalize
    if (cid.startsWith('done:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var mode = parts[2];
      var hour = parts[3];
      var role = parts[4];
      var dayIndex = parseInt(parts[5]);
      var rec = parts[6] === 'yes';
      return deferComponentAndProcess(res, appId, token, function() {
        return finishSignup(userId, displayName, activityId, mode, hour, role, rec, dayIndex);
      });
    }

    // Board: activity selected
    if (cid === 'board_activity_select') {
      var activityId = values[0];
      return deferComponentAndProcess(res, appId, token, function() {
        return handleBoardForActivity(activityId);
      });
    }

    // Move: day selected
    if (cid.startsWith('move_day:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var dayIndex = parseInt(parts[2]);
      return deferComponentAndProcess(res, appId, token, function() {
        return showMoveTimePicker(userId, displayName, activityId, dayIndex);
      });
    }

    // Move: time selected
    if (cid.startsWith('move_time:')) {
      var parts = cid.split(':');
      var activityId = parts[1];
      var moveDayIndex = parseInt(parts[2]);
      return deferComponentAndProcess(res, appId, token, function() {
        return finishMove(userId, displayName, activityId, values[0], moveDayIndex);
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
  if (day === 0) { if (pdtNow.getHours() < 14) result.setDate(result.getDate() - 7); }
  else { result.setDate(result.getDate() - day); }
  return result.getFullYear() + '-' + pad(result.getMonth() + 1) + '-' + pad(result.getDate());
}

// ===== Cloud functions =====

async function callApi(action, data) { data = data || {}; data.action = action; return await callCloudFunction('api', data); }
async function callLogin(uid, name) { return await callCloudFunction('login', { userId: uid, nickname: name }); }

async function getSlotData(weekDates, userId, dayDate, activityType) {
  // Accept single weekDate string or array
  var wds = Array.isArray(weekDates) ? weekDates : [weekDates];
  var allSlots = [];
  var apiParams = {};
  if (activityType) apiParams.activityType = activityType;
  var results = await Promise.all(wds.map(function(wd) {
    return callApi('getSlots', Object.assign({ weekDate: wd }, apiParams));
  }));
  results.forEach(function(res) {
    if (res.success && res.slots) allSlots = allSlots.concat(res.slots);
  });
  var slots = dayDate ? allSlots.filter(function(s) { return s.dayDate === dayDate; }) : allSlots;

  var counts = {};
  var carCounts = {};
  var fullCars = {};
  var userRole = null;
  slots.forEach(function(s) {
    counts[s.hour] = (counts[s.hour] || 0) + s.count;
    carCounts[s.hour] = (carCounts[s.hour] || 0) + 1;
    if (s.full) fullCars[s.hour] = (fullCars[s.hour] || 0) + 1;
    if (userId) {
      s.members.forEach(function(m) {
        if (m.openid === userId) userRole = m.role;
      });
    }
  });
  return { counts: counts, carCounts: carCounts, fullCars: fullCars, userRole: userRole, slots: allSlots };
}

function progressBar(count, max) {
  var filled = Math.round((count / max) * 10);
  var empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty) + ' ' + count + '/' + max;
}

function getRoleEmoji(roleName, config) {
  if (!config || !config.roles) return '🔵';
  var found = config.roles.find(function(r) { return r.name === roleName; });
  if (!found) return '🔵';
  if (found.color === '#3fb950') return '🟢';
  if (found.color === '#f85149') return '🔴';
  return '🔵';
}

var SPECIAL_USERS = ['yoky', 'ykoy', 'deand', '狐狸', '测试管理'];
function isSpecialUser(nickname) {
  return SPECIAL_USERS.indexOf((nickname || '').toLowerCase()) !== -1;
}

// ===== Step 0: activity selection / start signup =====

async function startSignup() {
  var activities = await getActivities();
  if (activities.length <= 1) {
    var activityId = activities.length === 1 ? activities[0].id : 'default';
    return replyRich({
      content: '**选择报名方式：**',
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: '⚡ 快速加入', custom_id: 'mode:' + activityId + ':quick' },
        { type: 2, style: 1, label: '🚗 创建车队', custom_id: 'mode:' + activityId + ':create' }
      ] }],
      flags: 64
    });
  }

  var options = activities.map(function(a) {
    return { label: a.name, value: a.id, description: a.description || '' };
  });
  return replyRich({
    content: '**选择活动：**',
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'activity_select', placeholder: '选择活动...', options: options
    }] }],
    flags: 64
  });
}

// ===== Recurring picker (extracted for deferred use) =====

async function showRecurringPicker(activityId, mode, hour, role, dayIndex) {
  var activities = await getActivities();
  var config = getActivityConfig(activities, activityId);
  var emoji = getRoleEmoji(role, config);
  return update({
    content: '**' + emoji + role + '** · 每周自动报名此时段？',
    components: [{ type: 1, components: [
      { type: 2, style: 1, label: '每周自动', custom_id: 'done:' + activityId + ':' + mode + ':' + hour + ':' + role + ':' + dayIndex + ':yes' },
      { type: 2, style: 2, label: '仅本周', custom_id: 'done:' + activityId + ':' + mode + ':' + hour + ':' + role + ':' + dayIndex + ':no' }
    ] }]
  });
}

// ===== Step 1.5: day picker =====

async function showDayPicker(userId, displayName, activityId, mode) {
  var weekDates = getWindowWeekDates();
  await callLogin(userId, displayName);
  var data = await getSlotData(weekDates, userId, null, activityId);
  var days = getRollingDays();

  var pdtNow = getPDTNow();
  var todayStr = fmtDate(pdtNow);

  var dayCounts = {};
  data.slots.forEach(function(s) {
    dayCounts[s.dayDate] = (dayCounts[s.dayDate] || 0) + s.count;
  });

  var buttons = days.map(function(d) {
    var c = dayCounts[d.dayDate] || 0;
    var isPast = d.dayDate < todayStr;
    var label = d.dayName + ' ' + d.shortDate + (c > 0 ? ' (' + c + '人)' : '');
    return { type: 2, style: c > 0 ? 1 : 2, label: label, custom_id: 'day:' + activityId + ':' + mode + ':' + d.windowIndex, disabled: isPast };
  });

  // 9 buttons → 3 rows: 4 + 3 + 2
  var rows = [];
  rows.push({ type: 1, components: buttons.slice(0, 4) });
  rows.push({ type: 1, components: buttons.slice(4, 7) });
  rows.push({ type: 1, components: buttons.slice(7, 9) });

  return update({
    content: '**选择日期' + (mode === 'create' ? '创建车队' : '报名') + '：**',
    components: rows
  });
}

// ===== Step 2: time picker =====

async function showTimePicker(userId, displayName, activityId, mode, windowIndex) {
  var activities = await getActivities();
  var config = getActivityConfig(activities, activityId);
  var HOURS = getHoursForActivity(config);

  var days = getRollingDays();
  var dayInfo = days[windowIndex];
  var dayDate = dayInfo.dayDate;
  var weekDates = getWindowWeekDates();

  var data = await getSlotData(dayInfo.weekDate, userId, dayDate, activityId);
  var counts = data.counts;
  var allData = await getSlotData(weekDates, userId, null, activityId);
  var lastRole = allData.userRole || (config.roles[0] ? config.roles[0].name : '输出');

  var lines = HOURS.map(function(h) {
    var c = counts[h] || 0;
    var cars = data.carCounts[h] || 0;
    if (c === 0) return discordTime(dayDate, h) + ' — 虚位以待';
    var bar = progressBar(c, cars * config.maxPerCar);
    return discordTime(dayDate, h) + ' ' + bar + ' (' + cars + '车)';
  });

  var options = [];
  if (mode === 'quick') {
    options.push({ label: '🎲 随缘', value: 'any', description: '加入最快满的车' });
  }
  HOURS.forEach(function(h) {
    var c = counts[h] || 0;
    var fire = c >= 7 ? ' 🔥' : '';
    options.push({ label: (h > 12 ? (h-12) : h) + ':00 PM (' + c + '人)' + fire, value: String(h), description: h + ':00 PT' });
  });

  var roleEmoji = getRoleEmoji(lastRole, config);

  // Build role switch buttons from config
  var roleButtons = config.roles.filter(function(r) { return r.name !== lastRole; }).map(function(r) {
    var em = r.color === '#3fb950' ? '🟢' : (r.color === '#f85149' ? '🔴' : '🔵');
    return { type: 2, style: 2, label: '切换为' + em + ' ' + r.name, custom_id: 'switchrole:' + activityId + ':' + mode + ':' + r.name + ':' + windowIndex };
  });

  var components = [
    { type: 1, components: [{
      type: 3, custom_id: 'time:' + activityId + ':' + mode + ':' + lastRole + ':' + windowIndex, placeholder: '选择时段...', options: options
    }] }
  ];
  if (roleButtons.length > 0) {
    components.push({ type: 1, components: roleButtons });
  }

  return update({
    content: '**' + dayInfo.dayName + ' ' + dayInfo.shortDate + ' · 选择时段' + (mode === 'create' ? '创建车队' : '报名') + '：**\n'
      + '当前职业：' + roleEmoji + lastRole + '\n\n' + lines.join('\n'),
    components: components
  });
}

async function showTimePickerWithRole(userId, displayName, activityId, mode, role, windowIndex) {
  var activities = await getActivities();
  var config = getActivityConfig(activities, activityId);
  var HOURS = getHoursForActivity(config);

  var days = getRollingDays();
  var dayInfo = days[windowIndex];
  var dayDate = dayInfo.dayDate;

  var data = await getSlotData(dayInfo.weekDate, userId, dayDate, activityId);
  var counts = data.counts;

  var lines = HOURS.map(function(h) {
    var c = counts[h] || 0;
    var cars = data.carCounts[h] || 0;
    if (c === 0) return discordTime(dayDate, h) + ' — 虚位以待';
    var bar = progressBar(c, cars * config.maxPerCar);
    return discordTime(dayDate, h) + ' ' + bar + ' (' + cars + '车)';
  });

  var options = [];
  if (mode === 'quick') {
    options.push({ label: '🎲 随缘', value: 'any', description: '加入最快满的车' });
  }
  HOURS.forEach(function(h) {
    var c = counts[h] || 0;
    var fire = c >= 7 ? ' 🔥' : '';
    options.push({ label: (h > 12 ? (h-12) : h) + ':00 PM (' + c + '人)' + fire, value: String(h), description: h + ':00 PT' });
  });

  var roleEmoji = getRoleEmoji(role, config);

  // Build role switch buttons from config
  var roleButtons = config.roles.filter(function(r) { return r.name !== role; }).map(function(r) {
    var em = r.color === '#3fb950' ? '🟢' : (r.color === '#f85149' ? '🔴' : '🔵');
    return { type: 2, style: 2, label: '切换为' + em + ' ' + r.name, custom_id: 'switchrole:' + activityId + ':' + mode + ':' + r.name + ':' + windowIndex };
  });

  var components = [
    { type: 1, components: [{
      type: 3, custom_id: 'time:' + activityId + ':' + mode + ':' + role + ':' + windowIndex, placeholder: '选择时段...', options: options
    }] }
  ];
  if (roleButtons.length > 0) {
    components.push({ type: 1, components: roleButtons });
  }

  return update({
    content: '**' + dayInfo.dayName + ' ' + dayInfo.shortDate + ' · 选择时段' + (mode === 'create' ? '创建车队' : '报名') + '：**\n'
      + '当前职业：' + roleEmoji + role + '\n\n' + lines.join('\n'),
    components: components
  });
}

// ===== Finalize signup =====

async function finishSignup(userId, displayName, activityId, mode, hourStr, role, recurring, windowIndex) {
  var activities = await getActivities();
  var config = getActivityConfig(activities, activityId);

  var days = getRollingDays();
  var dayInfo = days[windowIndex];
  var weekDate = dayInfo.weekDate;
  var dayDate = dayInfo.dayDate;
  var hour = hourStr === 'any' ? null : parseInt(hourStr);
  var action = mode === 'quick' ? 'quickJoin' : 'createTeam';

  var res = await callApi(action, {
    userId: userId, weekDate: weekDate, dayDate: dayDate, hour: hour,
    nickname: displayName, role: role, recurring: recurring,
    activityType: activityId
  });

  if (!res.success) return update({ content: '❌ ' + res.message, components: [] });

  var emoji = getRoleEmoji(role, config);
  var timeLabel = hour !== null ? discordTime(dayDate, hour) : '随缘';
  var modeLabel = mode === 'create' ? '创建了车队' : '加入了';
  var msg = '✅ **' + displayName + '** ' + modeLabel + ' ' + dayInfo.dayName + ' ' + timeLabel
    + ' 第' + (res.carIndex + 1) + '车 ' + emoji + role
    + (recurring ? '（每周自动）' : '');

  var board = await buildBoardEmbed(activityId);
  return update({ content: msg, embeds: [board], components: [] });
}

// ===== 代报 command =====

async function handleProxy(userId, displayName, opts) {
  var weekDates = getWindowWeekDates();
  var name = (opts['名字'] || '').trim().slice(0, 12);
  var role = opts['职业'] || '输出';
  var hourStr = opts['时段'];

  if (!name) return reply('❌ 请输入名字', true);

  await callLogin(userId, displayName);

  // Find user's activity type across all activities
  var activities = await getActivities();
  var foundActivityId = null;
  var mySlot = null;
  var myWeekDate = weekDates[0];

  for (var ai = 0; ai < activities.length; ai++) {
    var act = activities[ai];
    var allData = await getSlotData(weekDates, userId, null, act.id);
    allData.slots.forEach(function(s) {
      if (s.members.some(function(m) { return m.openid === userId; })) {
        mySlot = s;
        myWeekDate = s.weekDate;
        foundActivityId = act.id;
      }
    });
    if (foundActivityId) break;
  }

  var activityId = foundActivityId || (activities[0] ? activities[0].id : 'default');
  var config = getActivityConfig(activities, activityId);
  var hour = hourStr ? parseInt(hourStr) : (mySlot ? mySlot.hour : null);

  if (!mySlot) {
    var res = await callApi('quickJoin', {
      userId: userId, weekDate: myWeekDate, hour: hour,
      nickname: displayName, role: '输出', recurring: false,
      extraMembers: [{ nickname: name, role: role }],
      activityType: activityId
    });
    if (!res.success) return replyRich({ content: '❌ ' + res.message });
  } else {
    var res = await callApi('quickJoin', {
      userId: userId + '_p' + Date.now(),
      weekDate: myWeekDate, hour: hour,
      nickname: name, role: role, recurring: false,
      activityType: activityId
    });
  }

  var board = await buildBoardEmbed(activityId);
  var emoji = getRoleEmoji(role, config);
  return replyRich({ content: '✅ 已代报 **' + name + '** ' + emoji + role, embeds: [board] });
}

// ===== Move =====

async function startMove(userId, displayName) {
  var weekDates = getWindowWeekDates();
  await callLogin(userId, displayName);

  // Find user's activity type
  var activities = await getActivities();
  var foundActivityId = null;
  for (var ai = 0; ai < activities.length; ai++) {
    var act = activities[ai];
    var checkData = await getSlotData(weekDates, userId, null, act.id);
    var found = false;
    checkData.slots.forEach(function(s) {
      if (s.members.some(function(m) { return m.openid === userId; })) {
        foundActivityId = act.id;
        found = true;
      }
    });
    if (found) break;
  }

  var activityId = foundActivityId || (activities[0] ? activities[0].id : 'default');
  var data = await getSlotData(weekDates, null, null, activityId);
  var days = getRollingDays();

  var pdtNow = getPDTNow();
  var todayStr = fmtDate(pdtNow);

  var dayCounts = {};
  data.slots.forEach(function(s) {
    dayCounts[s.dayDate] = (dayCounts[s.dayDate] || 0) + s.count;
  });

  var buttons = days.map(function(d) {
    var c = dayCounts[d.dayDate] || 0;
    var isPast = d.dayDate < todayStr;
    var label = d.dayName + ' ' + d.shortDate + (c > 0 ? ' (' + c + '人)' : '');
    return { type: 2, style: c > 0 ? 1 : 2, label: label, custom_id: 'move_day:' + activityId + ':' + d.windowIndex, disabled: isPast };
  });

  var rows = [];
  rows.push({ type: 1, components: buttons.slice(0, 4) });
  rows.push({ type: 1, components: buttons.slice(4, 7) });
  rows.push({ type: 1, components: buttons.slice(7, 9) });

  return replyRich({
    content: '**选择要挪到的日期：**',
    components: rows,
    flags: 64
  });
}

async function showMoveTimePicker(userId, displayName, activityId, windowIndex) {
  var activities = await getActivities();
  var config = getActivityConfig(activities, activityId);
  var HOURS = getHoursForActivity(config);

  var days = getRollingDays();
  var dayInfo = days[windowIndex];
  var dayDate = dayInfo.dayDate;

  var data = await getSlotData(dayInfo.weekDate, null, dayDate, activityId);
  var counts = data.counts;

  var lines = HOURS.map(function(h) {
    var c = counts[h] || 0;
    var cars = data.carCounts[h] || 0;
    if (c === 0) return discordTime(dayDate, h) + ' — 虚位以待';
    return discordTime(dayDate, h) + ' ' + progressBar(c, cars * config.maxPerCar) + ' (' + cars + '车)';
  });
  var options = HOURS.map(function(h, i) {
    return { label: '第' + (i+1) + '场 (' + (counts[h]||0) + '人)', value: String(h), description: h + ':00 PT' };
  });

  return update({
    content: '**' + dayInfo.dayName + ' ' + dayInfo.shortDate + ' · 选择要挪到的时段：**\n' + lines.join('\n'),
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'move_time:' + activityId + ':' + windowIndex, placeholder: '选择目标时段...', options: options
    }] }]
  });
}

async function finishMove(userId, displayName, activityId, hourStr, windowIndex) {
  var days = getRollingDays();
  var dayInfo = days[windowIndex];
  var weekDate = dayInfo.weekDate;
  var dayDate = dayInfo.dayDate;

  var res = await callApi('move', { userId: userId, weekDate: weekDate, targetDayDate: dayDate, targetHour: parseInt(hourStr), nickname: displayName, activityType: activityId });
  if (!res.success) return update({ content: '❌ ' + res.message, components: [] });
  var board = await buildBoardEmbed(activityId);
  return update({ content: '🔄 **' + displayName + '** 挪到了 ' + dayInfo.dayName + ' ' + discordTime(dayDate, parseInt(hourStr)), embeds: [board], components: [] });
}

// ===== Leave / Board / Rename =====

async function handleLeave(userId) {
  var weekDates = getWindowWeekDates();

  // Find user's activity type across all activities
  var activities = await getActivities();
  var foundActivityId = null;
  var myWeekDate = null;

  for (var ai = 0; ai < activities.length; ai++) {
    var act = activities[ai];
    var allData = await getSlotData(weekDates, userId, null, act.id);
    var found = false;
    allData.slots.forEach(function(s) {
      if (s.members.some(function(m) { return m.openid === userId; })) {
        myWeekDate = s.weekDate;
        foundActivityId = act.id;
        found = true;
      }
    });
    if (found) break;
  }

  if (!myWeekDate) return reply('❌ 你当前未报名');
  var activityId = foundActivityId || (activities[0] ? activities[0].id : 'default');
  var res = await callApi('leave', { userId: userId, weekDate: myWeekDate, activityType: activityId });
  if (!res.success) return reply('❌ ' + res.message);
  var board = await buildBoardEmbed(activityId);
  return replyRich({ content: '👋 已退出报名', embeds: [board] });
}

async function handleBoard() {
  var activities = await getActivities();
  if (activities.length <= 1) {
    var activityId = activities.length === 1 ? activities[0].id : 'default';
    var board = await buildBoardEmbed(activityId);
    return replyRich({ embeds: [board] });
  }

  // Multiple activities: show selector
  var options = activities.map(function(a) {
    return { label: a.name, value: a.id, description: a.description || '' };
  });
  return replyRich({
    content: '**选择活动查看看板：**',
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'board_activity_select', placeholder: '选择活动...', options: options
    }] }],
    flags: 64
  });
}

async function handleBoardForActivity(activityId) {
  var board = await buildBoardEmbed(activityId);
  return update({ embeds: [board], components: [] });
}

async function handleRename(userId, opts) {
  var nick = (opts['名字'] || '').trim().slice(0, 12);
  if (!nick) return reply('❌ 请输入名字', true);
  await callApi('updateNickname', { userId: userId, nickname: nick });
  return reply('✅ 已改名为 **' + nick + '**', true);
}

// ===== Board Embed with leader =====

async function buildBoardEmbed(activityId) {
  var activities = await getActivities();
  var config = getActivityConfig(activities, activityId);
  var HOURS = getHoursForActivity(config);

  var weekDates = getWindowWeekDates();
  var allData = await getSlotData(weekDates, null, null, activityId);
  var slots = allData.slots;
  var days = getRollingDays();

  var totalPeople = 0;
  slots.forEach(function(s) { totalPeople += s.count; });

  var byDayHour = {};
  slots.forEach(function(s) {
    var key = (s.dayDate || s.weekDate) + ':' + s.hour;
    if (!byDayHour[key]) byDayHour[key] = [];
    byDayHour[key].push(s);
  });

  var fields = [];
  days.forEach(function(dayInfo) {
    HOURS.forEach(function(hour) {
      var key = dayInfo.dayDate + ':' + hour;
      var cars = byDayHour[key];
      if (!cars || cars.length === 0) return;
      cars.sort(function(a, b) { return a.carIndex - b.carIndex; });
      var lines = [];

      cars.forEach(function(car) {
        var leaderName = '';
        if (car.leader) {
          var leaderMember = car.members.find(function(m) { return m.openid === car.leader; });
          if (leaderMember) leaderName = ' 👑' + leaderMember.nickname;
        }
        var bar = progressBar(car.count, config.maxPerCar);
        lines.push('**第' + (car.carIndex + 1) + '车** ' + bar + leaderName);

        var sorted = car.members.slice().sort(function(a, b) {
          if (a.openid === car.leader) return -1;
          if (b.openid === car.leader) return 1;
          return 0;
        });
        var memberStrs = sorted.map(function(m) {
          var emoji = getRoleEmoji(m.role, config);
          var prefix = (m.openid === car.leader || isSpecialUser(m.nickname)) ? '👑' : emoji;
          var suffix = m.registeredBy ? '*' : '';
          return prefix + m.nickname + suffix;
        });
        lines.push(memberStrs.join('  '));
      });

      fields.push({
        name: '📅 ' + dayInfo.dayName + ' ' + dayInfo.shortDate + ' · 🕐 ' + discordTime(dayInfo.dayDate, hour) + ' 本地时间',
        value: lines.join('\n'), inline: false
      });
    });
  });

  if (fields.length === 0) {
    fields.push({ name: '暂无报名', value: '使用 /报名 加入', inline: false });
  }

  var f = days[0], la = days[days.length - 1];
  var rangeLabel = f.shortDate + ' ' + f.dayName + ' ~ ' + la.shortDate + ' ' + la.dayName;

  return {
    title: '🏯 ' + config.name,
    description: '📅 ' + rangeLabel + '  |  共 ' + totalPeople + ' 人',
    color: 0xf0b429, fields: fields,
    footer: { text: '/报名 加入 · /退出 离开 · /挪动 换时段 · /代报 帮别人 · /看板 刷新' }
  };
}
