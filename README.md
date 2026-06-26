# Tauri + Node.js + Rust + Vanilla
1. Ensure that Node.js and the Rust environment are installed on your computer.
2. Clone this repository and run `npm install`.
3. Run `npm run tauri dev` to launch the local desktop application.

# Environment
1. Node.js v22.x or v24.x ensure JavaScript running, and it uses NPM to organize offical packs from Node.js. Use NPM to download pack "demoparser2" to analysis and get data from CS2 Demos (this part is in parse_demo.cjs file)
2. Rust 1.90.0 is the backend. Compiles the final .exe program. Cargo is used to download Rust dependence and conpile Rust to binary (ensure brotli depencence uses alloc-stdlib v0.2.2)
3. Tauri from using NPM to download pack "tauri". Used to construct the frontend by letting webpage to be application. Uses Vanilla JS

## Recommended IDE Setup
- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)


# 6/26/2026 update
1. Added tool bar for more detail data and analysis.
2. inspect.cjs is for key word references uses in cmd, as key words of CS2 demo of events changes.
