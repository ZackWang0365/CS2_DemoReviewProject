use std::process::Command;

#[tauri::command]
fn parse_demo_file(file_path: String) -> Result<String, String> {
    println!("呼叫 Node.js 引擎解析 Demo: {}", file_path);

    // 调用系统的 node 命令，执行我们的 parse_demo.js，并把路径传给它
    let output = Command::new("node")
        .arg("../parse_demo.cjs")
        .arg(&file_path)
        .output();

    match output {
        Ok(out) => {
            if out.status.success() {
                // 如果脚本成功运行，截获它打印的 JSON 数据
                let json_str = String::from_utf8_lossy(&out.stdout).to_string();
                println!("✅ 解析成功！");
                Ok(json_str)
            } else {
                // 如果报错了，截获红色报错信息
                let err_str = String::from_utf8_lossy(&out.stderr).to_string();
                Err(format!("解析引擎报错: {}", err_str))
            }
        }
        Err(e) => Err(format!("无法启动 Node 环境: {}", e)),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // 🔴 补回丢失的默认组件 1
        .plugin(tauri_plugin_shell::init())  // 🔴 补回丢失的默认组件 2
        .invoke_handler(tauri::generate_handler![parse_demo_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}