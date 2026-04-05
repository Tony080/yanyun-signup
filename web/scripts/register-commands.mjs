#!/usr/bin/env node
/**
 * 注册 Discord slash commands（改完后需重新运行）
 *
 * 用法：
 *   DISCORD_APP_ID=xxx DISCORD_BOT_TOKEN=xxx DISCORD_GUILD_ID=xxx node scripts/register-commands.mjs
 */

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!APP_ID || !BOT_TOKEN) {
  console.error('需要设置 DISCORD_APP_ID 和 DISCORD_BOT_TOKEN 环境变量');
  process.exit(1);
}

const commands = [
  {
    name: '报名',
    description: '报名本周百业十人本（多轮选择时段、职业）'
  },
  {
    name: '退出',
    description: '退出本周报名'
  },
  {
    name: '挪动',
    description: '挪动到其他时间段（多轮选择）'
  },
  {
    name: '看板',
    description: '查看本周报名看板'
  },
  {
    name: '改名',
    description: '修改显示名称',
    options: [
      {
        name: '名字',
        description: '新名字（最多12字）',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: '代报',
    description: '帮别人报名',
    options: [
      {
        name: '名字',
        description: '被代报人的名字',
        type: 3,
        required: true
      },
      {
        name: '职业',
        description: '职业（默认输出）',
        type: 3,
        required: false,
        choices: [
          { name: '输出 🔵', value: '输出' },
          { name: '霖霖 🟢', value: '霖霖' }
        ]
      },
      {
        name: '时段',
        description: '时段 PT 小时（默认和你同时段）',
        type: 3,
        required: false,
        choices: [
          { name: '2 PM PT', value: '14' },
          { name: '3 PM PT', value: '15' },
          { name: '4 PM PT', value: '16' },
          { name: '5 PM PT', value: '17' },
          { name: '6 PM PT', value: '18' },
          { name: '7 PM PT', value: '19' },
          { name: '8 PM PT', value: '20' },
          { name: '9 PM PT', value: '21' },
          { name: '10 PM PT', value: '22' }
        ]
      }
    ]
  }
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

console.log('注册命令到:', GUILD_ID ? `服务器 ${GUILD_ID}` : '全局');

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bot ' + BOT_TOKEN
  },
  body: JSON.stringify(commands)
});

const data = await res.json();

if (res.ok) {
  console.log('✅ 注册成功！');
  data.forEach(function(cmd) {
    console.log('  /' + cmd.name + ' - ' + cmd.description);
  });
} else {
  console.error('❌ 注册失败:', JSON.stringify(data, null, 2));
}
