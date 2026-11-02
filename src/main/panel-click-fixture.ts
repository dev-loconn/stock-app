import { app, BrowserWindow } from 'electron';

// A separate process used only for an interactive first-click check. No app profile or network.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ x: 800, y: 450, width: 440, height: 220, show: false,
    title: '面板外部点击测试', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.setMenu(null);
  window.webContents.on('console-message', (_event, _level, message) => { if (message.startsWith('fixture-click:')) console.log(message); });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN"><title>面板外部点击测试</title>
    <style>body{background:#192334;color:#e3edf9;font:16px 'Segoe UI','Microsoft YaHei';padding:24px}button{font:inherit;padding:12px 24px}p{font-size:13px}</style>
    <button onclick="this.textContent='已点击 '+(++window.clicks)+' 次';console.log('fixture-click:'+window.clicks)">点击检查（0 次）</button>
    <p>独立进程测试窗口。第一次点击应正常生效，行情面板保持展开。</p><script>window.clicks=0</script>`));
  window.showInactive();
});
app.on('window-all-closed', () => app.quit());
