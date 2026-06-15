const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// 1. 获取页面元素 (注意这里使用了新的 ID)
const dropZone = document.getElementById('drop-zone');
const title = document.getElementById('drop-title'); 
const mapContainer = document.getElementById('map-container');
const canvas = document.getElementById('heatmap-canvas');
const ctx = canvas.getContext('2d');

// ================= 1. 建立全局地图配置字典 =================
// ================= 2. 建立全局地图配置字典 (CS2 核心图池全覆盖) =================
const MAP_CONFIGS = {
    // 经典三张
    "de_mirage":  { pos_x: -3230, pos_y: 1713, scale: 5.0,  imagePath: "./maps/de_mirage.jpg" },
    "de_inferno": { pos_x: -2087, pos_y: 3870, scale: 4.9,  imagePath: "./maps/de_inferno.jpg" },
    "de_dust2":   { pos_x: -2400, pos_y: 3200, scale: 4.4,  imagePath: "./maps/de_dust2.jpg" },
    
    // 现役与热门比赛图
    "de_nuke":    { pos_x: -3453, pos_y: 2887, scale: 7.0,  imagePath: "./maps/de_nuke.jpg" },
    "de_overpass":{ pos_x: -4831, pos_y: 1781, scale: 5.2,  imagePath: "./maps/de_overpass.jpg" },
    "de_vertigo": { pos_x: -3168, pos_y: 1762, scale: 4.0,  imagePath: "./maps/de_vertigo.jpg" },
    "de_ancient": { pos_x: -2953, pos_y: 2164, scale: 5.0,  imagePath: "./maps/de_ancient.jpg" },
    "de_anubis":  { pos_x: -2796, pos_y: 3328, scale: 5.22, imagePath: "./maps/de_anubis.jpg" },
    
    // 补充一些常见图 (可选)
    "de_train":   { pos_x: -2477, pos_y: 2392, scale: 4.7,  imagePath: "./maps/de_train.jpg" }
};

// 3. 坐标转换公式
function gameToPixel(gameX, gameY, config) {
    return {
        x: (gameX - config.pos_x) / config.scale,
        y: (config.pos_y - gameY) / config.scale 
    };
}



// ================= 3. 核心全局状态 (新增) =================
let currentDemoData = null; // 用来“记住”当前 Demo 的数据，方便复选框切换时秒切

// ================= 4. 动态绘制引擎 (大重构) =================

// 接收到新数据的入口
function renderDemoData(data) {
    currentDemoData = data; // 存入全局大脑
    
    // 恢复状态文字
    title.innerText = "✅ 分析完成";
    title.style.color = "#4ade80";

    redrawCanvas(); // 呼叫重绘函数
}

// 核心重绘逻辑（受复选框控制）
function redrawCanvas() {
    if (!currentDemoData) return;

    const mapName = currentDemoData.map_name;
    const currentMapConfig = MAP_CONFIGS[mapName];

    if (!currentMapConfig) {
        alert(`抱歉，当前暂不支持地图：${mapName}`);
        return;
    }

    // UI 显示地图
    mapContainer.classList.remove('hidden');
    mapContainer.style.backgroundImage = "url('" + currentMapConfig.imagePath + "')";

    // 清空上一帧的画布
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'screen';

    // 检查左侧控制面板，看哪些被勾选了
    const showKills = document.getElementById('filter-kills').checked;
    const showSmokes = document.getElementById('filter-smokes').checked;
    const showMolotovs = document.getElementById('filter-molotovs').checked;
    const showFlashes = document.getElementById('filter-flashes').checked;
    const showGrenades = document.getElementById('filter-grenades').checked;
    // 根据勾选状态，画出对应颜色的点
    // 击杀：血红色
    if (showKills) drawPoints(currentDemoData.kills, currentMapConfig, 'rgba(255, 50, 50, 0.9)'); 
    // 烟雾弹：灰白色
    if (showSmokes) drawPoints(currentDemoData.smokes, currentMapConfig, 'rgba(200, 200, 200, 0.8)'); 
    // 燃烧弹：烈焰橙
    if (showMolotovs) drawPoints(currentDemoData.molotovs, currentMapConfig, 'rgba(255, 120, 0, 0.9)'); 
    // 闪光弹：亮青色
    if (showFlashes) drawPoints(currentDemoData.flashes, currentMapConfig, 'rgba(100, 255, 255, 0.8)'); 
    // HE 爆炸：明亮黄色
    if (showGrenades) drawPoints(currentDemoData.grenades, currentMapConfig, 'rgba(255, 215, 0, 0.9)'); 
}

// 独立的画点刷子工具
function drawPoints(pointsArray, config, centerColor) {
    if (!pointsArray || pointsArray.length === 0) return;

    // 自动提取颜色代码里的 RGB 部分，用于制造边缘全透明的渐变效果
    const colorBase = centerColor.substring(0, centerColor.lastIndexOf(',')); 
    const transparentEdge = colorBase + ', 0)';

    pointsArray.forEach(point => {
        const pos = gameToPixel(point.x, point.y, config);

        const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 18);
        gradient.addColorStop(0, centerColor);     // 亮晶晶的中心
        gradient.addColorStop(1, transparentEdge); // 融于黑暗的边缘

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 18, 0, Math.PI * 2);
        ctx.fill();
    });
}

// ================= 5. 绑定左侧复选框点击事件 (新增) =================
const checkboxes = ['filter-kills', 'filter-smokes', 'filter-molotovs', 'filter-flashes', 'filter-grenades'];
checkboxes.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
        console.log(`切换了图层: ${id}`);
        redrawCanvas(); // 只要有任何勾选变化，瞬间重绘画布
    });
});



// ================= 系统拖拽事件监听 =================

listen('tauri://drag-enter', () => dropZone.classList.add('dragover'));
listen('tauri://drag-leave', () => dropZone.classList.remove('dragover'));

listen('tauri://drag-drop', (event) => {
  dropZone.classList.remove('dragover');
  const filePaths = event.payload.paths ? event.payload.paths : event.payload;

  if (filePaths && filePaths.length > 0) {
    const filePath = filePaths[0];

    if (filePath.endsWith('.dem')) {
      // 状态变成分析中
      title.innerText = "🔄 analysing...";
      title.style.color = "#eab308"; // 黄色
      
      console.log("正在发送给 Rust:", filePath);

      // 呼叫 Rust
      invoke('parse_demo_file', { filePath: filePath })
        .then((response) => {
            const parsedData = JSON.parse(response);
            renderDemoData(parsedData); 
        })
        .catch((error) => {
            console.error("call Rust failed:", error);
            title.innerText = "analysis failed";
            title.style.color = "#f87171"; // 红色
        });
    } else {
      title.innerText = "format error";
      title.style.color = "#f87171";
    }
  }
});

console.log("💥 main.js 已经重新加载完毕，准备就绪！");