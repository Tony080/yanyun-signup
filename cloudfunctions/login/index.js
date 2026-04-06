const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  // ===== 恢复模式：用恢复码找回账号 =====
  if (event.action === 'recover') {
    var code = (event.code || '').toUpperCase().trim();
    if (!code) return { success: false, message: '请输入恢复码' };

    var found = await db.collection('users').where({ recoveryCode: code }).get();
    if (found.data.length === 0) return { success: false, message: '恢复码无效' };

    var u = found.data[0];
    return {
      success: true,
      openid: u.openid,
      nickname: u.nickname,
      recoveryCode: u.recoveryCode,
      recurringHour: u.recurringHour != null ? u.recurringHour : null,
      recurringDay: u.recurringDay != null ? u.recurringDay : null
    };
  }

  // ===== 正常登录 =====
  var wxContext = cloud.getWXContext();
  var openid = wxContext.OPENID || event.userId;

  if (!openid) return { success: false, message: '无法识别用户' };

  var userRes = await db.collection('users').where({ openid: openid }).get();

  if (userRes.data.length > 0) {
    var user = userRes.data[0];
    // 老用户没有恢复码的补一个
    if (!user.recoveryCode) {
      var newCode = generateCode();
      await db.collection('users').doc(user._id).update({
        data: { recoveryCode: newCode }
      });
      user.recoveryCode = newCode;
    }
    return {
      openid: openid,
      nickname: user.nickname,
      recoveryCode: user.recoveryCode,
      recurringHour: user.recurringHour != null ? user.recurringHour : null,
      recurringDay: user.recurringDay != null ? user.recurringDay : null
    };
  }

  // 新用户
  var nickname = event.nickname || '水仙十字社小可爱' + openid.slice(-3).toUpperCase();
  var recoveryCode = generateCode();

  await db.collection('users').add({
    data: {
      openid: openid,
      nickname: nickname,
      recoveryCode: recoveryCode,
      createdAt: db.serverDate()
    }
  });

  return { openid: openid, nickname: nickname, recoveryCode: recoveryCode, recurringHour: null, recurringDay: null };
};

/** 生成6位恢复码 */
function generateCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0OI1
  var code = '';
  for (var i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
