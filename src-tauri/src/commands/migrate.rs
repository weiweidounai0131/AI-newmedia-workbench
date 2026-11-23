use crate::core::migrate::{
    self, CleanupRuntimeResult, LegacyMigrationPreview, MigrationOptions, MigrationReport,
};

#[tauri::command]
pub fn inspect_legacy_migration(custom_dir: Option<String>) -> LegacyMigrationPreview {
    migrate::inspect_legacy(custom_dir.as_deref())
}

#[tauri::command]
pub fn run_legacy_migration(options: MigrationOptions) -> Result<MigrationReport, String> {
    migrate::run_migration(options)
}

#[tauri::command]
pub fn cleanup_legacy_runtime(
    custom_dir: Option<String>,
    confirm_phrase: String,
) -> Result<CleanupRuntimeResult, String> {
    migrate::cleanup_legacy_runtime(custom_dir.as_deref(), &confirm_phrase)
}
