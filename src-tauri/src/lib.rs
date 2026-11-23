pub mod cdp;
pub mod commands;
pub mod core;
pub mod downloader;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            // 旧版 Electron 专属迁移工具
            commands::migrate::inspect_legacy_migration,
            commands::migrate::run_legacy_migration,
            commands::migrate::cleanup_legacy_runtime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI新媒体工作台");
}
