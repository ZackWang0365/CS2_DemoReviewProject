const { parseEvent, parseHeader } = require('@laihoe/demoparser2');

const filePath = process.argv[2];

try {
    // 1. 获取地图名
    let mapName = "DefaultMap"; // 先设置个默认值，防止引擎改版导致没有地图名
    try {
        const header = parseHeader(filePath);
        if (header && header.map_name) {
            mapName = header.map_name;
        }
    } catch (e) {}

    // 坐标提取
    // 引擎很坑：玩家死亡 user_X 道具爆炸 x
    function extractCoords(events, fallbackX = 'x', fallbackY = 'y') {
        const points = [];
        events.forEach(e => {
            const px = e.user_X !== undefined ? e.user_X : e[fallbackX];
            const py = e.user_Y !== undefined ? e.user_Y : e[fallbackY];
            // 过滤掉无效点
            if (px !== undefined && py !== undefined && !isNaN(px) && !isNaN(py)) {
                points.push({ x: px, y: py });
            }
        });
        return points;
    }

    //抓取四种不同的游戏事件
    const deathEvents = parseEvent(filePath, "player_death", ["X", "Y"]);
    const smokeEvents = parseEvent(filePath, "smokegrenade_detonate");
    const molotovEvents = parseEvent(filePath, "inferno_startburn");
    const flashEvents = parseEvent(filePath, "flashbang_detonate");
    const grenadeEvents = parseEvent(filePath, "hegrenade_detonate");

    //打包成 JSON
    const result = {
        map_name: mapName,
        kills: extractCoords(deathEvents, "X", "Y"),
        smokes: extractCoords(smokeEvents),
        molotovs: extractCoords(molotovEvents),
        flashes: extractCoords(flashEvents),
        grenades: extractCoords(grenadeEvents)
    };
    
    console.log(JSON.stringify(result));

} catch (e) {
    console.error("解析脚本发生错误:", e.message);
    process.exit(1);
}