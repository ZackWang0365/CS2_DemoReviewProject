// inspect.cjs —— 字段名诊断工具
// 放在项目根目录（和 parse_demo.cjs、node_modules 同级），然后：
//   Windows:  node inspect.cjs "C:\路径\你的demo.dem"
//   mac/linux: node inspect.cjs /路径/你的demo.dem
//
// 它会打印：1) 这个 demo 里有哪些 game event  2) 关键事件的真实字段名 + 一条示例
// 把输出（尤其带 *** 标记的几行）发给我，我据此校正 parse_demo.cjs 里的字段名。
//
//使用方法：打开cmd
//cd /d C:\你的项目根目录
//node inspect.cjs "C:\路径\你的demo.dem"



const dp = require('@laihoe/demoparser2');
const file = process.argv[2];
if (!file) {
  console.error('用法: node inspect.cjs <demo.dem 的完整路径>');
  process.exit(1);
}

function dump(name, playerProps = [], otherProps = [], note = '') {
  try {
    const rows = dp.parseEvent(file, name, playerProps, otherProps) || [];
    console.log(`\n=== ${name} ===  (${rows.length} 行)` + (note ? `   ${note}` : ''));
    if (rows.length) {
      console.log('字段名:', Object.keys(rows[0]).join(', '));
      console.log('示例行:', JSON.stringify(rows[0]));
    } else {
      console.log('（无数据：该 demo 可能不含此事件，或事件名不同）');
    }
  } catch (e) {
    console.log(`\n=== ${name} ===  解析出错: ${e.message}`);
  }
}

// 1) 这个 demo 里到底有哪些事件
try {
  const evs = dp.listGameEvents(file) || [];
  console.log('该 demo 包含的 game events（' + evs.length + ' 种）:');
  console.log(evs.sort().join(', '));
} catch (e) {
  console.log('listGameEvents 不可用:', e.message);
}

// 2) 关键事件的真实字段名
// *** 重点看 player_death 里有没有 attacker_team_num / user_team_num ***
dump('player_death', ['team_num'], [],
  '*** 找 attacker_team_num / user_team_num；以及 headshot / assister_steamid / assistedflash / weapon ***');
// *** 重点看 round_end 的“胜方”字段叫什么（winner? winner_team? team? reason?）***
dump('round_end', [], [], '*** 找“胜方”字段：winner / winner_team / team ... ***');
// *** player_hurt 找 dmg_health ***
dump('player_hurt', ['team_num'], [], '*** 找 dmg_health（伤害）和 weapon ***');
// *** player_blind 找 blind_duration ***
dump('player_blind', ['team_num'], [], '*** 找 blind_duration（致盲时长）***');
dump('bomb_planted');
dump('bomb_defused');
dump('bomb_exploded');

// 3) 名单字段
try {
  const info = dp.parsePlayerInfo(file) || [];
  console.log('\n=== parsePlayerInfo ===  (' + info.length + ' 人)');
  if (info.length) {
    console.log('字段名:', Object.keys(info[0]).join(', '));
    console.log('示例行:', JSON.stringify(info[0]));
  }
} catch (e) {
  console.log('parsePlayerInfo 出错:', e.message);
}

console.log('\n—— 完。把上面的输出（尤其 *** 那几行的字段名）发给我即可。');
