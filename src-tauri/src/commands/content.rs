use crate::core::hot_rank::{self, AllHotRanksResult, HotRankItem};

#[tauri::command]
pub async fn get_hot_ranks() -> AllHotRanksResult {
    hot_rank::fetch_all_hot_ranks().await
}

#[tauri::command]
pub async fn get_hot_rank_by_platform(platform: String) -> Result<Vec<HotRankItem>, String> {
    hot_rank::fetch_hot_rank(&platform).await
}
