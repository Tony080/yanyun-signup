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
    myRegistration: null,
    isRecurring: false,
    recurringHour: null,
    recurringLocalDisplay: '',
    loading: true,
    actionLoading: false,

    // Signup modal state
    showSignupModal: false,
    signupMode: '',        // 'quick' or 'create'
    signupHour: null,      // null = 随缘 (only for quick mode)
    signupRole: '输出',
    signupRecurring: false,
    signupExtras: [],      // [{nickname, role}]
    extraNameInput: '',
    extraRoleInput: '输出',

    // Time picker
    timePickerOptions: [],
    timePickerIndex: 0
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

  // Build picker options based on current slotsMap + mode
  buildTimePickerOptions: function (mode) {
    var slotsMap = this.data.slotsMap;
    var timeSlots = this.data.timeSlots;
    var options = [];

    if (mode === 'quick') {
      options.push({ label: '🎲 随缘', pdtHour: null });
    }

    for (var i = 0; i < timeSlots.length; i++) {
      var ts = timeSlots[i];
      var count = slotsMap[ts.pdtHour] ? slotsMap[ts.pdtHour].totalCount : 0;
      var label = ts.display + '（' + count + '人）';
      options.push({ label: label, pdtHour: ts.pdtHour });
    }

    return options;
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

  // ===== 报名弹窗 =====

  openSignupModal: function (e) {
    var mode = e.currentTarget.dataset.mode; // 'quick' or 'create'
    var hour = e.currentTarget.dataset.hour;  // optional: pre-selected hour
    var options = this.buildTimePickerOptions(mode);

    var pickerIndex = 0;
    if (hour !== undefined && hour !== null) {
      var hourNum = Number(hour);
      for (var i = 0; i < options.length; i++) {
        if (options[i].pdtHour === hourNum) {
          pickerIndex = i;
          break;
        }
      }
    }

    this.setData({
      showSignupModal: true,
      signupMode: mode,
      signupHour: options[pickerIndex].pdtHour,
      signupRole: '输出',
      signupRecurring: false,
      signupExtras: [],
      extraNameInput: '',
      extraRoleInput: '输出',
      timePickerOptions: options,
      timePickerIndex: pickerIndex
    });
  },

  closeSignupModal: function () {
    this.setData({ showSignupModal: false });
  },

  // Prevent tap-through on modal overlay
  preventBubble: function () {},

  onTimePickerChange: function (e) {
    var idx = Number(e.detail.value);
    var options = this.data.timePickerOptions;
    this.setData({
      timePickerIndex: idx,
      signupHour: options[idx].pdtHour
    });
  },

  selectRole: function (e) {
    var role = e.currentTarget.dataset.role;
    this.setData({ signupRole: role });
  },

  toggleSignupRecurring: function () {
    this.setData({ signupRecurring: !this.data.signupRecurring });
  },

  onExtraNameInput: function (e) {
    this.setData({ extraNameInput: e.detail.value });
  },

  selectExtraRole: function (e) {
    var role = e.currentTarget.dataset.role;
    this.setData({ extraRoleInput: role });
  },

  addExtra: function () {
    var name = this.data.extraNameInput.trim();
    if (!name) {
      wx.showToast({ title: '请输入名字', icon: 'none' });
      return;
    }
    var extras = this.data.signupExtras.concat([{
      nickname: name.slice(0, 12),
      role: this.data.extraRoleInput
    }]);
    this.setData({
      signupExtras: extras,
      extraNameInput: ''
    });
  },

  removeExtra: function (e) {
    var idx = Number(e.currentTarget.dataset.idx);
    var extras = this.data.signupExtras.filter(function (_, i) { return i !== idx; });
    this.setData({ signupExtras: extras });
  },

  // Submit signup
  submitSignup: async function () {
    if (this.data.actionLoading) return;

    var mode = this.data.signupMode;
    var pdtHour = this.data.signupHour;
    var role = this.data.signupRole;
    var recurring = this.data.signupRecurring;
    var extras = this.data.signupExtras;
    var weekDate = this.data.weekDate;
    var nickname = this.data.nickname;

    if (mode === 'create' && pdtHour === null) {
      wx.showToast({ title: '创建车队需选择时段', icon: 'none' });
      return;
    }

    this.setData({ actionLoading: true });

    try {
      var action = mode === 'quick' ? 'quickJoin' : 'createTeam';
      var callData = {
        action: action,
        weekDate: weekDate,
        hour: pdtHour,
        nickname: nickname,
        role: role,
        recurring: recurring
      };

      if (extras.length > 0) {
        callData.extraMembers = extras;
      }

      var res = await wx.cloud.callFunction({
        name: 'api',
        data: callData
      });

      if (res.result.success) {
        var localDisplay = pdtHour !== null ? this.getLocalDisplay(pdtHour) : '随缘';
        var msg = mode === 'quick' ? '已加入 ' + localDisplay : '已创建车队 ' + localDisplay;
        if (recurring) msg += '（每周自动）';
        wx.showToast({ title: msg, icon: 'none' });

        if (recurring && pdtHour !== null) {
          this.setData({
            isRecurring: true,
            recurringHour: pdtHour,
            recurringLocalDisplay: this.getLocalDisplay(pdtHour)
          });
        }

        this.setData({ showSignupModal: false });
        await this.loadSlots();
        this.requestSubscribe();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      console.error('submitSignup failed', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // ===== Per-slot join button =====

  handleSlotJoin: function (e) {
    var hour = e.currentTarget.dataset.hour;
    this.openSignupModal({
      currentTarget: {
        dataset: { mode: 'quick', hour: hour }
      }
    });
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

  // ===== Remove proxy member =====

  handleRemoveProxy: async function (e) {
    var memberOpenid = e.currentTarget.dataset.memberOpenid;
    var memberNickname = e.currentTarget.dataset.memberNickname;
    var slotId = e.currentTarget.dataset.slotId;

    var confirm = await this.showConfirm('移除代报', '确定移除 ' + memberNickname + '？');
    if (!confirm) return;

    this.setData({ actionLoading: true });

    try {
      var res = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'removeProxy',
          weekDate: this.data.weekDate,
          slotId: slotId,
          memberOpenid: memberOpenid
        }
      });

      if (res.result.success) {
        wx.showToast({ title: '已移除 ' + memberNickname });
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
