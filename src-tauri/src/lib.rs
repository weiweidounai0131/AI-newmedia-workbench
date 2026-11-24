pub mod cdp;
pub mod commands;
pub mod core;
pub mod downloader;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // 系统健康与探测
            commands::system::get_system_health,
            // 四能力 AI 设置与安全存储
            commands::settings::get_settings,
            commands::settings::set_capability,
            commands::settings::set_provider_key,
            commands::settings::save_provider,
            commands::settings::delete_capability_config,
            commands::settings::fetch_provider_models,
            commands::settings::verify_capability,
            commands::settings::set_root_dir,
            commands::settings::set_xhs_download_dir,
            // AI 业务能力（创意 / 提示词 / 洗稿 / 出图）
            commands::ai::creative_directions,
            commands::ai::creative_generate,
            commands::ai::creative_optimize,
            commands::ai::gen_tishici,
            commands::ai::xigao_recognize,
            commands::ai::xigao_rewrite,
            commands::ai::chutu_generate,
            commands::ai::chutu_providers,
            // 热榜内容
            commands::content::get_hot_ranks,
            commands::content::get_hot_rank_by_platform,
            // 本地素材库与纯 Rust Word/Excel 导出
            commands::library::list_library,
            commands::library::set_library_root,
            commands::library::initialize_library,
            commands::library::export_library_file,
            commands::library::build_word_download,
            commands::library::parse_word_base64,
            commands::library::read_library_word,
            commands::library::open_library_file,
            commands::library::read_library_image_data_url,
            // Phase 3 Rust 原生 CDP 引擎（扫码登录 / 登录态 / 主动搜索 / 冷却）
            commands::scrape::scrape_status,
            commands::scrape::scrape_cooldowns,
            commands::scrape::scrape_login_qr,
            commands::scrape::scrape_login_session,
            commands::scrape::scrape_login,
            commands::scrape::scrape_logout,
            commands::scrape::search_content,
            // Phase 4 Rust 原生下载器与来源识别（替代 wechat-mp-tools）
            commands::download::xigao_douyin_start,
            commands::download::xigao_douyin_status,
            commands::download::xigao_douyin_source,
            commands::download::xigao_xhs_start,
            commands::download::xigao_xhs_status,
            commands::download::xigao_xhs_source,
            commands::download::xigao_recognize_source,
            commands::download::xigao_recognize_link,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AI新媒体工作台");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // 退出工作台时干净回收本次拉起的浏览器进程，同时保留磁盘 Profile 登录态
            cdp::manager::shutdown_all_sync();
        }
    });
}
