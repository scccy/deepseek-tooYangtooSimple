use crate::service::workflow::{
    status::{self, Status},
    utils,
};
use tauri::AppHandle;

/// 检测 dsh 进程状态并更新
///
/// 使用 HTTP 请求检测 Harness 服务是否真正就绪，就绪后更新全局状态
pub async fn trigger(app_handle: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let current_status = status::get_status();

    let port = crate::config::get_store_dat_setting(&app_handle).port;
    let is_dsh_running = utils::is_dsh_running(port).await;
    log::trace!("DSH status check: dsh_running={}", is_dsh_running);

    // 只有当当前状态为运行中时，才更新状态
    if is_dsh_running && current_status != Status::Running {
        status::set_status(Status::Running);
        status::emit_status(&app_handle);
    }

    Ok(())
}
