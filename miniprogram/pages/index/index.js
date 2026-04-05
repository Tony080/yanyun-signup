var week = require('../../utils/week');
var getCurrentSunday = week.getCurrentSunday;
var SLOT_HOURS_PDT = week.SLOT_HOURS_PDT;
var pdtToLocal = week.pdtToLocal;

Page({
  data: {
    openid: '',
    nickname: '',
    nicknameInput: '',
    weekDate: '',
    weekLabel: '',
    pdtLabel: '',
    timeSlots: [],
    slotsMap: {},
    myRegistration: null, // { hour, carIndex, slotId, localDisplay }
    isRecurring: false,   // 当前用户是否开启了每周自动
    recurringHour: null,  // 自动报名的PDT小时
    loading: true,
    actionLoading: false
  },

  onLoad: function () {
    this.init();
  },

  onPullDownRefresh: function () {
    this.loadSlots().then(function () { wx.stopPullDownRefresh(); });
  },

  init: async function () {
    wx.showLoading({ title: '加载中...' });
    try {
      var res = await wx.cloud.callFunction({ name: 'login' });
      var openid = res.result.openid;
      var nickname = res.result.nickname;
      var recurringHour = res.result.recurringHour;
      var weekDate = getCurrentSunday();

      // 构建本地化时间段
      var timeSlots = SLOT_HOURS_PDT.map(function (pdtHour) {
        var local = pdtToLocal(weekDate, pdtHour);
        return {
          pdtHour: pdtHour,
          display: local.display,
          shortDisplay: local.shortDisplay,
          weekday: local.weekday,
          dateLabel: local.dateLabel
        };
      });

      var first = timeSlots[0];
      var last = timeSlots[timeSlots.length - 1];
      var weekLabel = first.dateLabel + ' ' + first.display + ' - ' + last.shortDisplay;
      var pdtDateParts = weekDate.split('-');
      var pdtLabel = '美西 ' + parseInt(pdtDateParts[1]) + '月' + parseInt(pdtDateParts[2]) + '日 周日 14:00-22:00';

      var recurringLocalDisplay = recurringHour != null
        ? pdtToLocal(weekDate, recurringHour).display
        : '';

      this.setData({
        openid: openid,
        nickname: nickname,
        nicknameInput: nickname,
        weekDate: weekDate,
        weekLabel: weekLabel,
        pdtLabel: pdtLabel,
        timeSlots: timeSlots,
        isRecurring: recurringHour != null,
        recurringHour: recurringHour,
        recurringLocalDisplay: recurringLocalDisplay
      });

      await this.loadSlots();
    } catch (err) {
      console.error('init failed', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  getLocalDisplay: function (pdtHour) {
    return pdtToLocal(this.data.weekDate, pdtHour).display;
  },

  loadSlots: async function () {
    var weekDate = this.data.weekDate;
    var openid = this.data.openid;
    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'getSlots', weekDate: weekDate }
      });

      if (!res.result.success) return;

      var slots = res.result.slots;
      var slotsMap = {};
      var myRegistration = null;

      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i];
        var h = slot.hour;
        if (!slotsMap[h]) {
          slotsMap[h] = { cars: [], totalCount: 0 };
        }
        slotsMap[h].cars.push(slot);
        slotsMap[h].totalCount += slot.count;

        if (slot.members.some(function (m) { return m.openid === openid; })) {
          myRegistration = {
            hour: h,
            carIndex: slot.carIndex,
            slotId: slot._id,
            localDisplay: this.getLocalDisplay(h)
          };
        }
      }

      for (var key in slotsMap) {
        slotsMap[key].cars.sort(function (a, b) { return a.carIndex - b.carIndex; });
      }

      this.setData({ slotsMap: slotsMap, myRegistration: myRegistration, loading: false });
    } catch (err) {
      console.error('loadSlots failed', err);
      this.setData({ loading: false });
    }
  },

  // ===== 昵称 =====

  onNicknameInput: function (e) {
    this.setData({ nicknameInput: e.detail.value });
  },

  saveNickname: async function () {
    var nicknameInput = this.data.nicknameInput;
    var nickname = this.data.nickname;
    var trimmed = nicknameInput.trim();
    if (!trimmed || trimmed === nickname) return;
    var newName = trimmed.slice(0, 12);

    try {
      wx.showLoading({ title: '保存中...' });
      await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'updateNickname', nickname: newName }
      });
      this.setData({ nickname: newName, nicknameInput: newName });
      wx.hideLoading();
      wx.showToast({ title: '昵称已更新' });
      this.loadSlots();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '更新失败', icon: 'none' });
    }
  },

  // ===== 报名 =====

  handleJoin: async function (e) {
    var pdtHour = Number(e.currentTarget.dataset.hour);
    var weekDate = this.data.weekDate;
    var nickname = this.data.nickname;
    if (this.data.actionLoading) return;

    var localDisplay = this.getLocalDisplay(pdtHour);
    var self = this;

    // 1. 选择职业
    var roleIndex = await new Promise(function (resolve) {
      wx.showActionSheet({
        itemList: ['输出', '霖霖'],
        success: function (r) { resolve(r.tapIndex); },
        fail: function () { resolve(-1); }
      });
    });
    if (roleIndex === -1) return; // 取消
    var role = roleIndex === 0 ? '输出' : '霖霖';

    // 2. 每周自动？
    var modalRes = await new Promise(function (resolve) {
      wx.showModal({
        title: '报名 ' + localDisplay,
        content: '职业：' + role + '\n每周自动报名此时段？',
        confirmText: '每周自动',
        cancelText: '仅本周',
        success: resolve
      });
    });

    var recurring = modalRes.confirm;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'join',
          weekDate: weekDate,
          hour: pdtHour,
          nickname: nickname,
          role: role,
          recurring: recurring
        }
      });

      if (res.result.success) {
        var msg = '已报名 ' + localDisplay;
        if (recurring) msg += '（每周自动）';
        wx.showToast({ title: msg, icon: 'none' });

        self.setData({
          isRecurring: recurring,
          recurringHour: recurring ? pdtHour : null,
          recurringLocalDisplay: recurring ? localDisplay : ''
        });
        await self.loadSlots();
        self.requestSubscribe();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      self.setData({ actionLoading: false });
    }
  },

  // ===== 退出 =====

  handleLeave: async function () {
    if (this.data.actionLoading) return;

    var content = '确定要退出本周报名吗？';
    if (this.data.isRecurring) {
      content += '\n每周自动报名也会一并取消';
    }

    var confirm = await this.showConfirm('确认退出', content);
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'leave', weekDate: this.data.weekDate }
      });

      if (res.result.success) {
        wx.showToast({ title: '已退出报名' });
        // 不清除 isRecurring，下周 autoRegister 仍会自动报名
        await this.loadSlots();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== 挪动 =====

  handleMove: async function (e) {
    var targetPdtHour = Number(e.currentTarget.dataset.hour);
    var weekDate = this.data.weekDate;
    var nickname = this.data.nickname;
    var myReg = this.data.myRegistration;
    if (this.data.actionLoading) return;

    var fromDisplay = this.getLocalDisplay(myReg.hour);
    var toDisplay = this.getLocalDisplay(targetPdtHour);

    var extra = '';
    if (this.data.isRecurring) {
      extra = '\n每周自动报名也会跟着改';
    }

    var confirm = await this.showConfirm(
      '确认挪动',
      '从 ' + fromDisplay + ' 挪到 ' + toDisplay + '？' + extra
    );
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: { action: 'move', weekDate: weekDate, targetHour: targetPdtHour, nickname: nickname }
      });

      if (res.result.success) {
        wx.showToast({ title: '已挪到 ' + toDisplay });
        if (this.data.isRecurring) {
          this.setData({
            recurringHour: targetPdtHour,
            recurringLocalDisplay: toDisplay
          });
        }
        await this.loadSlots();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== 取消/开启 每周自动 =====

  toggleRecurring: async function () {
    var newRecurring = !this.data.isRecurring;

    if (newRecurring) {
      // 开启：需要知道绑哪个时段
      var myReg = this.data.myRegistration;
      if (!myReg) {
        wx.showToast({ title: '请先报名一个时段', icon: 'none' });
        return;
      }
      var hour = myReg.hour;
      try {
        await wx.cloud.callFunction({
          name: 'api',
          data: { action: 'setRecurring', hour: hour }
        });
        this.setData({
          isRecurring: true,
          recurringHour: hour,
          recurringLocalDisplay: this.getLocalDisplay(hour)
        });
        wx.showToast({ title: '已开启每周自动', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    } else {
      // 关闭
      try {
        await wx.cloud.callFunction({
          name: 'api',
          data: { action: 'setRecurring', hour: null }
        });
        this.setData({
          isRecurring: false,
          recurringHour: null,
          recurringLocalDisplay: ''
        });
        wx.showToast({ title: '已取消每周自动', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    }
  },

  // ===== 订阅通知 =====

  _tmplId: 'DF5oEnfQ6QkoTW-5nQcPalEi4ITthx6Q1_OSXyXKfvk',

  requestSubscribe: function () {
    var tmplId = this._tmplId;
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: function (res) {
        if (res[tmplId] === 'accept') {
          wx.showToast({ title: '开车前30分钟会通知你', icon: 'none' });
        }
      },
      fail: function () {}
    });
  },

  subscribeNotify: async function () {
    var tmplId = this._tmplId;
    try {
      var res = await wx.requestSubscribeMessage({ tmplIds: [tmplId] });
      if (res[tmplId] === 'accept') {
        wx.showToast({ title: '订阅成功，开车前30分钟通知你' });
      } else {
        wx.showToast({ title: '需要允许通知才能收到提醒', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '订阅失败', icon: 'none' });
    }
  },

  // ===== 工具 =====

  showConfirm: function (title, content) {
    return new Promise(function (resolve) {
      wx.showModal({
        title: title,
        content: content,
        success: function (res) { resolve(res.confirm); }
      });
    });
  }
});
