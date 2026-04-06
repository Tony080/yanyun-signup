const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const https = require('https');
const { getSecrets } = require('./config');

const PDT_OFFSET = -7;
var WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
const DISCORD_CHANNEL_ID = '1490236180325990530';

/**
 * 每小时 :50 触发，每天 13:50-21:50 PDT 发送开车前10分钟提醒
 */
exports.main = async (event, context) => {
  var secrets = await getSecrets(db);
  var now = new Date();
  var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  var pdtNow = new Date(utcMs + PDT_OFFSET * 3600000);

  var targetHour = pdtNow.getHours() + 1;
  if (targetHour < 14 || targetHour > 22) {
    return { skipped: true, reason: 'outside slot hours' };
  }

  // 今天的 dayDate 和对应的 weekDate（回退到本周日）
  var dayDate = formatDate(pdtNow);
  var weekDate = getWeekDateForDay(pdtNow);
  console.log('[提醒] weekDate=' + weekDate + ' dayDate=' + dayDate + ' targetHour=' + targetHour);

  var slotsRes = await db.collection('slots')
    .where({ weekDate: weekDate, dayDate: dayDate, hour: targetHour })
    .get();

  if (slotsRes.data.length === 0) {
    console.log('[提醒] 无人报名');
    return { sent: 0 };
  }

  // 构建提醒内容
  var slots = slotsRes.data.sort(function(a, b) { return a.carIndex - b.carIndex; });
  var totalPeople = 0;
  slots.forEach(function(s) { totalPeople += s.count; });

  // ===== Discord 通知 =====
  await sendDiscordReminder(weekDate, targetHour, slots, totalPeople);

  // ===== 微信订阅消息（可选）=====
  var wxSent = 0;
  if (secrets.WX_TMPL_ID && secrets.WX_TMPL_ID !== 'YOUR_SUBSCRIBE_TEMPLATE_ID') {
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      for (var j = 0; j < slot.members.length; j++) {
        var m = slot.members[j];
        // 跳过 Discord 用户（dc_ 开头，没有微信 openid）
        if (m.openid.startsWith('dc_') || m.openid.startsWith('web_')) continue;
        try {
          await cloud.openapi.subscribeMessage.send({
            touser: m.openid,
            templateId: secrets.WX_TMPL_ID,
            page: 'pages/index/index',
            data: {
              thing1: { value: '燕云十六声 百业十人本' },
              time2: { value: weekDate + ' ' + targetHour + ':00 PDT' },
              thing3: { value: '第' + (slot.carIndex + 1) + '车 10分钟后开车！' }
            }
          });
          wxSent++;
        } catch (e) {
          console.warn('[微信通知跳过]', m.nickname, e.errCode || e.message);
        }
      }
    }
  }

  console.log('[提醒完成] Discord已推送, 微信发送:' + wxSent);
  return { discord: true, wxSent: wxSent };
};

// ===== Discord 推送 =====

async function sendDiscordReminder(weekDate, hour, slots, totalPeople) {
  var localTime = pdtToLocal(weekDate, hour);

  var fields = slots.map(function(car) {
    var members = car.members.map(function(m) {
      return (m.role === '霖霖' ? '🟢' : '🔵') + m.nickname;
    });
    return {
      name: '第' + (car.carIndex + 1) + '车 (' + car.count + '/10)',
      value: members.join('  '),
      inline: false
    };
  });

  var embed = {
    title: '🚗 百业十人本 10分钟后开车！',
    description: '🕐 **' + localTime + '**  (PDT ' + hour + ':00)  |  共 ' + totalPeople + ' 人',
    color: 0xf0b429,
    fields: fields,
    footer: { text: '准时开车，不见不散！' }
  };

  var body = JSON.stringify({
    content: '@everyone 开车提醒！',
    embeds: [embed]
  });

  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/channels/' + DISCORD_CHANNEL_ID + '/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bot ' + secrets.DISCORD_BOT_TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[Discord] 推送成功');
          resolve();
        } else {
          console.error('[Discord] 推送失败:', res.statusCode, data);
          resolve(); // 不阻断流程
        }
      });
    });
    req.on('error', function(e) { console.error('[Discord]', e); resolve(); });
    req.write(body);
    req.end();
  });
}

function pdtToLocal(pdtDateStr, pdtHour) {
  var p = pdtDateStr.split('-');
  var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], pdtHour - PDT_OFFSET, 0, 0));
  return WEEKDAYS[dt.getDay()] + ' ' + pad(dt.getHours()) + ':00';
}

// 回退到本周日（用于确定当天属于哪个 weekDate）
function getWeekDateForDay(pdtNow) {
  var result = new Date(pdtNow);
  result.setDate(result.getDate() - pdtNow.getDay());
  return formatDate(result);
}

function formatDate(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function pad(n) { return String(n).padStart(2, '0'); }
