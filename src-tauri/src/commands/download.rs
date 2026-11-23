use serde::Serialize;
use tauri::AppHandle;

use crate::downloader::douyin::{self, DouyinDownloadTask};
use crate::downloader::source_store::{self, RecognizeSourceResp, SourceSnapshot};
use crate::downloader::xhs::{self, XhsDownloadTask};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDownloadResp {
    pub task_id: String,
}

#[tauri::command]
pub fn xigao_douyin_start(app: AppHandle, link: String) -> Result<StartDownloadResp, String> {
    if link.trim().is_empty() {
        return Err("抖音链接不能为空".into());
    }
    let task_id = douyin::start_task(app, link);
    Ok(StartDownloadResp { task_id })
}

#[tauri::command]
pub fn xigao_douyin_status(task_id: String) -> Result<DouyinDownloadTask, String> {
    douyin::get_task(&task_id).ok_or_else(|| "抖音下载任务不存在或已过期".to_string())
}

#[tauri::command]
pub fn xigao_douyin_source(path: String, title: Option<String>) -> Result<SourceSnapshot, String> {
    source_store::import_douyin_video(&path, title)
}

#[tauri::command]
pub fn xigao_xhs_start(app: AppHandle, link: String) -> Result<StartDownloadResp, String> {
    if link.trim().is_empty() {
        return Err("小红书链接不能为空".into());
    }
    let task_id = xhs::start_task(app, link);
    Ok(StartDownloadResp { task_id })
}

#[tauri::command]
pub fn xigao_xhs_status(task_id: String) -> Result<XhsDownloadTask, String> {
    xhs::get_task(&task_id).ok_or_else(|| "小红书下载任务不存在或已过期".to_string())
}

#[tauri::command]
pub fn xigao_xhs_source(path: String, title: Option<String>) -> Result<SourceSnapshot, String> {
    source_store::import_xhs_note(&path, title)
}

#[tauri::command]
pub async fn xigao_recognize_source(source_id: String) -> Result<RecognizeSourceResp, String> {
    source_store::recognize_source(&source_id).await
}

#[tauri::command]
pub async fn xigao_recognize_link(link: String) -> Result<RecognizeSourceResp, String> {
    source_store::recognize_public_link(&link).await
}
