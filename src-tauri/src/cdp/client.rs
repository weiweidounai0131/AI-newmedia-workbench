use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
}

#[derive(Clone)]
pub struct CdpSession {
    tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    events: broadcast::Sender<CdpEvent>,
    next_id: Arc<AtomicU64>,
}

impl CdpSession {
    pub async fn connect(ws_url: &str) -> Result<Self, String> {
        let (ws_stream, _) = connect_async(ws_url)
            .await
            .map_err(|e| format!("连接浏览器 CDP 失败：{e}"))?;
        let (mut write, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel::<CdpEvent>(256);

        let pending_reader = Arc::clone(&pending);
        let events_reader = events.clone();

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(val) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = val.get("id").and_then(|v| v.as_u64()) {
                    let sender = {
                        let mut guard = pending_reader.lock().await;
                        guard.remove(&id)
                    };
                    if let Some(s) = sender {
                        if let Some(err) = val.get("error") {
                            let msg = err
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("CDP 调用错误")
                                .to_string();
                            let _ = s.send(Err(msg));
                        } else {
                            let _ = s.send(Ok(val.get("result").cloned().unwrap_or(Value::Null)));
                        }
                    }
                } else if let Some(method) = val.get("method").and_then(|v| v.as_str()) {
                    let _ = events_reader.send(CdpEvent {
                        method: method.to_string(),
                        params: val.get("params").cloned().unwrap_or(Value::Null),
                    });
                }
            }
        });

        let session = Self {
            tx,
            pending,
            events,
            next_id: Arc::new(AtomicU64::new(1)),
        };

        // 启用核心域
        let _ = session.send("Page.enable", json!({})).await;
        let _ = session.send("Network.enable", json!({})).await;
        let _ = session.send("Runtime.enable", json!({})).await;

        Ok(session)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    pub async fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (res_tx, res_rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id, res_tx);
        }
        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string();

        if self.tx.send(payload).is_err() {
            let mut guard = self.pending.lock().await;
            guard.remove(&id);
            return Err("浏览器 CDP 连接已关闭".into());
        }

        match tokio::time::timeout(Duration::from_secs(20), res_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("浏览器 CDP 响应通道中断".into()),
            Err(_) => {
                let mut guard = self.pending.lock().await;
                guard.remove(&id);
                Err(format!("CDP 命令超时：{method}"))
            }
        }
    }

    pub async fn eval_json(&self, expression: &str) -> Result<Value, String> {
        let res = self
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(ex) = res.get("exceptionDetails") {
            let msg = ex
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("页面脚本执行异常");
            return Err(msg.to_string());
        }
        Ok(res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        self.send("Page.navigate", json!({ "url": url })).await?;
        Ok(())
    }

    pub async fn add_stealth_script(&self, script: &str) -> Result<(), String> {
        self.send(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )
        .await?;
        Ok(())
    }

    pub async fn capture_clip_png(
        &self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<String, String> {
        let res = self
            .send(
                "Page.captureScreenshot",
                json!({
                    "format": "png",
                    "clip": {
                        "x": x,
                        "y": y,
                        "width": width,
                        "height": height,
                        "scale": 1
                    }
                }),
            )
            .await?;
        res.get("data")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "截图返回空数据".to_string())
    }

    pub async fn get_cookies(&self) -> Result<Vec<Value>, String> {
        let res = self.send("Network.getAllCookies", json!({})).await?;
        Ok(res
            .get("cookies")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default())
    }

    pub async fn get_response_body(&self, request_id: &str) -> Result<String, String> {
        let res = self
            .send("Network.getResponseBody", json!({ "requestId": request_id }))
            .await?;
        let body = res
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(body)
    }
}
