#!/usr/bin/env node
/**
 * 一次性脚本：注册 Discord slash commands
 *
 * 用法：
 *   DISCORD_APP_ID=xxx DISCORD_BOT_TOKEN=xxx DISCORD_GUILD_ID=xxx node scripts/register-commands.mjs
 *
 * DISCORD_GUILD_ID 可选。填了注册为服务器命令（立即生效），不填注册为全局命令（最多1小时生效）
 */

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!APP_ID || !BOT_TOKEN) {
  console.error('需要设置 DISCORD_APP_ID 和 DISCORD_BOT_TOKEN 环境变量');
  process.exit(1);
}

const timeChoices = [
  { name: '14:00 PDT (2PM)', value: '14' },
  { name: '15:00 PDT (3PM)', value: '15' },
  { name: '16:00 PDT (4PM)', value: '16' },
  { name: '17:00 PDT (5PM)', value: '17' },
  { name: '18:00 PDT (6PM)', value: '18' },
  { name: '19:00 PDT (7PM)', value: '19' },
  { name: '20:00 PDT (8PM)', value: '20' },
  { name: '21:00 PDT (9PM)', value: '21' },
  { name: '22:00 PDT (10PM)', value: '22' }
];

const roleChoices = [
  { name: '输出 🔵', value: '输出' },
  { name: '霖霖 🟢', value: '霖霖' }
];

const commands = [
  {
    name: '报名',
    description: '报名本周百业十人本',
    options: [
      {
        name: '时段',
        description: '选择时间段 (PDT)',
        type: 3, // STRING
        required: true,
        choices: timeChoices
      },
      {
        name: '职业',
        description: '选择职业（默认输出）',
        type: 3,
        required: false,
        choices: roleChoices
      }
    ]
  },
  {
    name: '退出',
    description: '退出本周报名'
  },
  {
    name: '挪动',
    description: '挪动到其他时间段',
    options: [
      {
        name: '时段',
        description: '目标时间段 (PDT)',
        type: 3,
        required: true,
        choices: timeChoices
      }
    ]
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
  }
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

console.log('注册命令到:', GUILD_ID ? `服务器 ${GUILD_ID}` : '全局');
console.log('命令数量:', commands.length);

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
